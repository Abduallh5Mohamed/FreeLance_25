-- Simplify RLS policies for teacher_messages to work with both authenticated and unauthenticated users
DROP POLICY IF EXISTS "Students can view their messages" ON teacher_messages;
DROP POLICY IF EXISTS "Students and admins can send messages" ON teacher_messages;
DROP POLICY IF EXISTS "Admins can update messages" ON teacher_messages;

-- Allow all operations on teacher_messages (application logic will handle filtering)
CREATE POLICY "Allow all operations on teacher_messages" 
ON teacher_messages 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- Make the table accessible to anonymous users for student messaging
ALTER TABLE teacher_messages ENABLE RLS;