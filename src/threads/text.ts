export function characters(value:string):number{let n=0;for(const _point of value)n++;return n;}
export function excerpt(value:string,offset:number,size:number):string{let n=0,text='';for(const point of value){if(n>=offset+size)break;if(n++>=offset)text+=point;}return text.toWellFormed();}
export const digestText=(value:string):string=>new Bun.CryptoHasher('sha256').update(value).digest('hex');
