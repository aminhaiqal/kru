ALTER TABLE work_projects ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(files_json));
