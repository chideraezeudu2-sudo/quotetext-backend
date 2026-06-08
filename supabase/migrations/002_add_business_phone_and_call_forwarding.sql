-- Add business_phone and call_forwarding_enabled columns to businesses table
alter table businesses
add column if not exists business_phone text,
add column if not exists call_forwarding_enabled boolean default false;
