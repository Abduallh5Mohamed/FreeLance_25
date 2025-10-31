import mysql from 'mysql2/promise';
import crypto from 'crypto';

async function assignStudentToGroup() {
  try {
    const connection = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '123580',
      database: 'Freelance'
    });

    console.log('✅ Connected to database');

    // Get a student user
    const [students] = await connection.query(
      `SELECT u.id as user_id, u.name, u.phone, s.id as student_id, s.group_id 
       FROM users u 
       LEFT JOIN students s ON u.student_id = s.id 
       WHERE u.role = 'student' 
       LIMIT 5`
    );

    if (students.length === 0) {
      console.log('❌ No student users found');
      process.exit(1);
    }

    console.log('\n📊 Current Students:');
    console.table(students);

    // Get available groups
    const [groups] = await connection.query(
      'SELECT id, name, grade_id FROM `groups` WHERE is_active = TRUE'
    );

    console.log('\n📊 Available Groups:');
    console.table(groups);

    // Assign first student to first group if not already assigned
    if (students[0] && groups[0]) {
      const student = students[0];
      const group = groups[0];
      
      if (!student.student_id) {
        // Create student record
        const studentId = crypto.randomUUID();
        await connection.query(
          `INSERT INTO students (id, name, email, phone, group_id, is_active) 
           VALUES (?, ?, ?, ?, ?, TRUE)`,
          [studentId, student.name, null, student.phone, group.id]
        );
        
        // Update user with student_id
        await connection.query(
          'UPDATE users SET student_id = ? WHERE id = ?',
          [studentId, student.user_id]
        );
        
        console.log(`\n✅ Created student record and assigned to group: ${group.name}`);
      } else if (!student.group_id) {
        // Update existing student with group
        await connection.query(
          'UPDATE students SET group_id = ? WHERE id = ?',
          [group.id, student.student_id]
        );
        
        console.log(`\n✅ Assigned student to group: ${group.name}`);
      } else {
        console.log(`\n✅ Student already in a group`);
      }
    }

    // Show updated students
    const [updatedStudents] = await connection.query(
      `SELECT 
        u.id as user_id,
        u.name,
        s.id as student_id,
        s.group_id,
        g.name as group_name
       FROM users u
       LEFT JOIN students s ON u.student_id = s.id
       LEFT JOIN \`groups\` g ON s.group_id = g.id
       WHERE u.role = 'student'
       LIMIT 5`
    );

    console.log('\n📊 Updated Students with Groups:');
    console.table(updatedStudents);

    await connection.end();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

assignStudentToGroup();
