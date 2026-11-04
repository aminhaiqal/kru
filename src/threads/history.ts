import type { Store } from '../store';
import type { SQLQueryBindings } from 'bun:sqlite';
import { createHmac,timingSafeEqual } from 'node:crypto';
import { ThreadStore } from './store';
import type { HistoryRecord } from './records';
import type { HistoryEntry,HistoryPage,HistorySearch,HistorySearchArgs } from './types';
import { HistoryInputError,HistoryStorageError } from './types';
import { characters,excerpt } from './text';

interface Row extends HistoryRecord {version_seq:number;first_seq:number;related_entry_id?:string|null}
interface Cursor {v:1;thread:string;snapshot:number;mode:'query'|'messageId';value:string;anchor:string;offset:number}
const cte=`WITH ranked AS (SELECT *,min(version_seq) OVER(PARTITION BY thread_id,source_id) AS first_seq,
  row_number() OVER(PARTITION BY thread_id,source_id ORDER BY version_seq DESC) AS version_rank
  FROM history_versions WHERE thread_id=? AND version_seq<=?), visible AS (SELECT * FROM ranked WHERE version_rank=1 AND outcome NOT IN ('starting','running'))`;
const tuple='order_seq,phase,item_order,source_id';
export class SqliteHistory implements HistorySearch {
  constructor(private readonly store:Store){}
  snapshotSeq():number{return this.store.db.query<{seq:number},[]>('SELECT coalesce(max(seq),0) AS seq FROM events').get()!.seq;}
  private secret():string{return this.store.db.query<{cursor_key:string},[]>('SELECT cursor_key FROM store_identity WHERE id=1').get()!.cursor_key;}
  private encode(cursor:Cursor):string {
    const body=Buffer.from(JSON.stringify(cursor)).toString('base64url');return body+'.'+createHmac('sha256',this.secret()).update(body).digest('base64url');
  }
  private decode(value:string,thread:string,mode:Cursor['mode'],query:string):Cursor {
    try{
      if(typeof value!=='string'||value.length>2048)throw new Error();
      const [body,signature,...rest]=value.split('.');if(!body||!signature||rest.length)throw new Error();
      const expected=createHmac('sha256',this.secret()).update(body).digest(),provided=Buffer.from(signature,'base64url');
      if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw new Error();
      const c=JSON.parse(Buffer.from(body,'base64url').toString()) as Cursor;
      if(c.v!==1||c.thread!==thread||c.mode!==mode||c.value!==query||!Number.isSafeInteger(c.snapshot)||c.snapshot<0||c.snapshot>this.snapshotSeq()||!Number.isSafeInteger(c.offset)||c.offset<0||typeof c.anchor!=='string')throw new Error();return c;
    }catch{throw new HistoryInputError('Invalid history cursor for this thread/query/source');}
  }
  private rows(thread:string,snapshot:number,options:{query?:string;source?:string;anchor?:Row;limit:number;oldest?:boolean;conversation?:boolean;exclude?:string[]}):Row[]{
    const args:SQLQueryBindings[]=[thread,snapshot];let where='1';
    if(options.query!==undefined){where+=' AND instr(kru_fold(text),?)>0';args.push(options.query.toLowerCase());}
    if(options.source){where+=' AND (source_id=? OR item_id=?)';args.push(options.source,options.source);}
    if(options.anchor){where+=` AND (${tuple})<(?,?,?,?)`;args.push(options.anchor.order_seq,options.anchor.phase,options.anchor.item_order,options.anchor.source_id);}
    if(options.conversation)where+=" AND role IN ('user','agent','routine','assistant','execution')";
    if(options.exclude?.length){where+=' AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE e.value=message_id)';args.push(JSON.stringify(options.exclude));}
    const direction=options.oldest?'ASC':'DESC';args.push(options.limit);
    return this.store.db.query<Row,SQLQueryBindings[]>(`${cte} SELECT *,
      (SELECT a.source_id FROM visible a WHERE a.execution_id=visible.execution_id AND a.role='assistant' ORDER BY a.item_order DESC LIMIT 1) AS related_entry_id
      FROM visible WHERE ${where} ORDER BY order_seq ${direction},phase ${direction},item_order ${direction},source_id ${direction} LIMIT ?`).all(...args);
  }
  private entry(row:Row,text=row.text,truncated=false):HistoryEntry {
    const entry={sourceId:row.source_id,executionId:row.execution_id,role:row.role,seq:row.version_seq,text,truncated,outcome:row.outcome,partial:row.partial===1,
      ...(row.message_id?{messageId:row.message_id,sender:{kind:row.sender_kind,...(row.sender_agent_id?{agentId:row.sender_agent_id}:{}),...(row.sender_routine_id?{routineId:row.sender_routine_id}:{})},replyTo:row.reply_to,chainId:row.chain_id,hop:row.hop}:{}),
      ...(row.item_id?{itemId:row.item_id}:{}),...(row.related_entry_id&&row.role!=='assistant'?{relatedEntryId:row.related_entry_id}:{})} as unknown as HistoryEntry;
    // Read-only library aliases do not duplicate every field in model tool responses.
    Object.defineProperties(entry,{id:{value:row.source_id,enumerable:false},status:{value:row.outcome,enumerable:false},timestamp:{value:row.timestamp,enumerable:false},baseSeq:{value:row.order_seq,enumerable:false},phase:{value:row.phase,enumerable:false},itemOrder:{value:row.item_order,enumerable:false}});return entry;
  }
  private page(threadId:string|null,snapshotSeq:number,entries:HistoryEntry[],nextCursor:string|null,gaps:string[],omitted=false):HistoryPage {
    const page={threadId,snapshotSeq,matches:entries,nextCursor,omitted:omitted||gaps.length>0,gaps} as HistoryPage;
    Object.defineProperty(page,'entries',{value:entries,enumerable:false});return page;
  }
  private fits(page:HistoryPage,maxBytes:number):boolean {
    const text=JSON.stringify(page);
    return characters(text)<=8000&&Buffer.byteLength(JSON.stringify({success:true,contentItems:[{type:'inputText',text}]}))<=maxBytes;
  }
  query(agentId:string,laneId:string|null,args:HistorySearchArgs,options:{maxBytes?:number}={}):HistoryPage {
    try{return this.queryInner(agentId,laneId,args,options.maxBytes??32768);}
    catch(error){if(error instanceof HistoryInputError)throw error;throw new HistoryStorageError(`History lookup failed: ${error instanceof Error?error.message:String(error)}`);}
  }
  private queryInner(agentId:string,laneId:string|null,args:HistorySearchArgs,maxBytes:number):HistoryPage {
    const mode=args.query!==undefined?'query':'messageId',value=args.query??args.messageId;
    if((args.query===undefined)===(args.messageId===undefined)||typeof value!=='string'||!value.trim()||characters(value)>(mode==='query'?200:256))throw new HistoryInputError('Provide exactly one of query or messageId');
    const limit=args.limit??6;if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw new HistoryInputError('limit must be between 1 and 20');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<512)throw new HistoryInputError('History result byte budget is too small');
    const thread=new ThreadStore(this.store).get(agentId,laneId),normalized=mode==='query'?value.toLowerCase():value;
    if(!thread)return this.page(null,this.snapshotSeq(),[],null,[]);
    const cursor=args.cursor===undefined?undefined:this.decode(args.cursor,thread.id,mode,normalized),snapshot=cursor?.snapshot??this.snapshotSeq();
    const gaps=this.store.db.query<{reason:string},[string,number]>('SELECT reason FROM history_gaps WHERE thread_id=? AND recorded_seq<=?').all(thread.id,snapshot).map(r=>r.reason);
    let anchor:Row|undefined;
    if(cursor){anchor=this.rows(thread.id,snapshot,{source:cursor.anchor,limit:1})[0];if(!anchor||(mode==='query'&&!anchor.text.toLowerCase().includes(normalized)))throw new HistoryInputError('History cursor anchor is unavailable');}
    if(mode==='messageId'){
      const row=this.rows(thread.id,snapshot,{source:value,limit:1})[0];if(!row)return this.page(thread.id,snapshot,[],null,gaps);
      if(cursor&&cursor.anchor!==row.source_id)throw new HistoryInputError('History cursor source differs');
      const offset=cursor?.offset??0,total=characters(row.text);if(offset>total)throw new HistoryInputError('History cursor offset is unavailable');
      let size=Math.min(800,Math.max(0,total-offset)),page:HistoryPage;
      do{
        const next=offset+size<total?this.encode({v:1,thread:thread.id,snapshot,mode,value:normalized,anchor:row.source_id,offset:offset+size}):null;
        page=this.page(thread.id,snapshot,[this.entry(row,excerpt(row.text,offset,size),offset+size<total)],next,gaps,offset+size<total);
        if(this.fits(page,maxBytes))return page;size=Math.floor(size/2);
      }while(size>0);
      throw new HistoryInputError('History entry metadata exceeds result budget');
    }
    const rows=this.rows(thread.id,snapshot,{query:value,...(anchor?{anchor}:{}),limit:limit+1}),entries:HistoryEntry[]=[];let page=this.page(thread.id,snapshot,entries,null,gaps);
    for(const [index,row] of rows.slice(0,limit).entries()){
      const match=row.text.toLowerCase().indexOf(normalized),start=Math.max(0,characters(row.text.slice(0,Math.max(0,match)))-120),total=characters(row.text);
      let size=Math.min(800,total-start),added=false;
      while(size>0||total===0){
        const entry=this.entry(row,excerpt(row.text,start,size),start>0||start+size<total);
        const next=index+1<rows.length?this.encode({v:1,thread:thread.id,snapshot,mode,value:normalized,anchor:row.source_id,offset:0}):null;
        const candidate=this.page(thread.id,snapshot,[...entries,entry],next,gaps,Boolean(next)||entries.some(e=>e.truncated)||entry.truncated);
        if(this.fits(candidate,maxBytes)){entries.push(entry);page=candidate;added=true;break;}
        if(size===0)break;size=Math.floor(size/2);
      }
      if(!added){if(!entries.length)throw new HistoryInputError('History entry metadata exceeds result budget');break;}
    }
    return page;
  }
  search(agentId:string,laneId:string|null,query:string,limit=6,cursor?:string):HistoryPage{return this.query(agentId,laneId,{query,limit,...(cursor===undefined?{}:{cursor})});}
  /** Legacy library convenience. Model-facing exact retrieval uses messageId + opaque cursor. */
  read(agentId:string,laneId:string|null,entryId:string,offset=0):HistoryPage {
    if(!Number.isSafeInteger(offset)||offset<0)throw new HistoryInputError('Invalid history offset');
    let page=this.query(agentId,laneId,{messageId:entryId});
    while(offset>0&&page.nextCursor){const length=characters(page.entries[0]?.text??'');if(length>offset)break;offset-=length;page=this.query(agentId,laneId,{messageId:entryId,cursor:page.nextCursor});}
    if(offset&&page.entries[0]){const old=page.entries[0]!;old.text=excerpt(old.text,offset,800);}
    page.offset=arguments[3]??0;page.nextOffset=page.nextCursor?(page.offset??0)+characters(page.entries[0]?.text??''):null;return page;
  }
  handoffEntries(threadId:string,exclude:string[],snapshot=this.snapshotSeq()):{entries:HistoryEntry[];more:boolean;gaps:string[]} {
    return this.store.db.transaction(()=>{
      const first=this.rows(threadId,snapshot,{limit:2,oldest:true,conversation:true,exclude}),recent=this.rows(threadId,snapshot,{limit:41,conversation:true,exclude});
      const rows=[...new Map([...first,...recent.slice(0,40)].map(r=>[r.source_id,r])).values()];
      return {entries:rows.map(r=>this.entry(r)).sort(compareEntries),more:recent.length>40,gaps:this.store.db.query<{reason:string},[string,number]>('SELECT reason FROM history_gaps WHERE thread_id=? AND recorded_seq<=?').all(threadId,snapshot).map(r=>r.reason)};
    }).deferred();
  }
}
export function compareEntries(a:HistoryEntry,b:HistoryEntry):number{return a.baseSeq-b.baseSeq||a.phase-b.phase||a.itemOrder-b.itemOrder||a.id.localeCompare(b.id);}
