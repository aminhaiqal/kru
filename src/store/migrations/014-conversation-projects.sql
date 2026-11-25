ALTER TABLE conversation_settings ADD COLUMN project_id TEXT REFERENCES work_projects(id);
