-- Fix teacher_messages foreign key constraint issue
-- Make sender_id nullable to allow both student messages and admin messages
ALTER TABLE teacher_messages ALTER COLUMN sender_id DROP NOT NULL;

-- If there's a foreign key constraint causing issues, we'll drop it
-- and recreate it to point to the students table instead
DO $$ 
BEGIN
    -- Drop existing foreign key if it exists
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'teacher_messages_sender_id_fkey'
        AND table_name = 'teacher_messages'
    ) THEN
        ALTER TABLE teacher_messages DROP CONSTRAINT teacher_messages_sender_id_fkey;
    END IF;
    
    -- Add new foreign key to students table with ON DELETE CASCADE
    ALTER TABLE teacher_messages 
    ADD CONSTRAINT teacher_messages_sender_id_fkey 
    FOREIGN KEY (sender_id) 
    REFERENCES students(id) 
    ON DELETE CASCADE;
END $$;