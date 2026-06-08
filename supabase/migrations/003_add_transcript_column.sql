-- Add transcript and job_description columns to jobs table
alter table jobs
add column if not exists transcript text,
add column if not exists job_description text;
