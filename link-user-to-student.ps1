# Link user to student by phone number
$phone = "01029290728"

Write-Host "🔍 Searching for user and student with phone: $phone" -ForegroundColor Cyan

# Check if student exists with this phone
$checkStudent = @"
SELECT id, name, phone FROM students WHERE phone = '$phone';
"@

Write-Host "`n📋 Checking students table..." -ForegroundColor Yellow
mysql -uroot -proot freelance -e $checkStudent

# Check if user exists
$checkUser = @"
SELECT id, name, phone, student_id FROM users WHERE phone = '$phone';
"@

Write-Host "`n📋 Checking users table..." -ForegroundColor Yellow
mysql -uroot -proot freelance -e $checkUser

Write-Host "`n"
$confirm = Read-Host "Do you want to link this user to student? (y/n)"

if ($confirm -eq 'y') {
    # Update user with student_id
    $updateQuery = @"
UPDATE users u
JOIN students s ON s.phone = u.phone
SET u.student_id = s.id
WHERE u.phone = '$phone';
"@

    Write-Host "`n🔄 Linking user to student..." -ForegroundColor Green
    mysql -uroot -proot freelance -e $updateQuery
    
    Write-Host "`n✅ User linked to student!" -ForegroundColor Green
    
    # Show result
    mysql -uroot -proot freelance -e $checkUser
} else {
    Write-Host "`n❌ Operation cancelled" -ForegroundColor Red
}
