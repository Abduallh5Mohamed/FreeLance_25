#!/bin/bash
# Create new user account

# Generate UUID
USER_ID=$(uuidgen)

# Hash password (bcrypt with 10 rounds)
HASHED_PASSWORD=$(node -e "console.log(require('bcrypt').hashSync('TabwebAcademy12345', 10))")

# Insert user
mysql -u root -p123580 Freelance <<SQL
INSERT INTO users (
  id,
  email,
  phone,
  password_hash,
  name,
  role,
  is_active,
  email_verified,
  phone_verified,
  created_at,
  updated_at
) VALUES (
  '$USER_ID',
  'admin@tabwebacademy.local',
  NULL,
  '$HASHED_PASSWORD',
  'Tabweb Admin',
  'admin',
  1,
  1,
  0,
  NOW(),
  NOW()
);

SELECT id, name, email, role FROM users WHERE email = 'mohamed96ramadan1996@gmail.com';
SQL

echo "✅ User created successfully!"
