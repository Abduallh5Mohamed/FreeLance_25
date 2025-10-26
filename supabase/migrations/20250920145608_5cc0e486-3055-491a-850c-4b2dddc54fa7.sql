-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Students can view their messages" ON teacher_messages;
DROP POLICY IF EXISTS "Students and admins can send messages" ON teacher_messages;
DROP POLICY IF EXISTS "Admins can update messages" ON teacher_messages;
DROP POLICY IF EXISTS "Teachers can view all messages" ON teacher_messages;

-- Allow all operations on teacher_messages (application logic will handle proper filtering)
CREATE POLICY "Allow all teacher message operations" 
ON teacher_messages 
FOR ALL 
USING (true) 
WITH CHECK (true);