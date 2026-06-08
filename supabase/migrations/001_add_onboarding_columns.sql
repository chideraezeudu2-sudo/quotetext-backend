-- Migration: Add onboarding flow columns to businesses table
-- Run this in Supabase SQL Editor

ALTER TABLE businesses 
ADD COLUMN IF NOT EXISTS preferred_supplier text,
ADD COLUMN IF NOT EXISTS store_location text,
ADD COLUMN IF NOT EXISTS delivery_preference text,
ADD COLUMN IF NOT EXISTS onboarding_step text DEFAULT 'start';

-- Also update existing businesses that might have old onboarding fields
UPDATE businesses 
SET onboarding_step = 'complete' 
WHERE onboarding_complete = true AND (onboarding_step IS NULL OR onboarding_step = 'start');