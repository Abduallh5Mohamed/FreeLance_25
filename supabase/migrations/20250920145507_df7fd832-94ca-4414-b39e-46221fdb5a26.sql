-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Users can send messages" ON teacher_messages;
DROP POLICY IF EXISTS "Users can view their own messages" ON teacher_messages;

-- Allow students to insert messages (they use student_id, not auth)
CREATE POLICY "Students and admins can send messages" 
ON teacher_messages 
FOR INSERT 
WITH CHECK (true);

-- Allow students to view messages where they are involved
CREATE POLICY "Students can view their messages" 
ON teacher_messages 
FOR SELECT 
USING (
  student_id IN (
    SELECT students.id 
    FROM students 
    WHERE students.email = current_setting('app.current_student_email', true)
  )
  OR EXISTS (
    SELECT 1 
    FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);

-- Allow admins to update message status (mark as read, etc)
CREATE POLICY "Admins can update messages" 
ON teacher_messages 
FOR UPDATE 
USING (
  EXISTS (
    SELECT 1 
    FROM profiles 
    WHERE profiles.user_id = auth.uid() 
    AND profiles.role = 'admin'::user_role
  )
);