# Test Login with Phone

## Working Configuration
✅ Database: Freelance (MySQL local)
✅ Server: http://localhost:3001
✅ Admin User Created:
- Phone: 01095336760
- Password: 11223344
- Role: admin

## System Already Supports Phone Login
The authentication system (`server/src/routes/auth.ts`) **already supports** phone-based login:

```typescript
// Login endpoint accepts phone OR email
const { phone, email, password } = req.body;
const identifier = phone ? phone.trim() : (email || '').toLowerCase().trim();
const where = phone ? 'phone = ?' : 'email = ?';
```

## Test Login

### Using curl (if available):
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"01095336760\",\"password\":\"11223344\"}"
```

### Using Postman or Thunder Client:
```
POST http://localhost:3001/api/auth/login
Content-Type: application/json

{
  "phone": "01095336760",
  "password": "11223344"
}
```

### Expected Response:
```json
{
  "user": {
    "id": "xxx-xxx-xxx",
    "phone": "01095336760",
    "name": "Admin User",
    "role": "admin",
    "is_active": true
  },
  "token": "eyJhbGciOiJIUzI1..."
}
```

## Frontend Integration

Update your login form to send `phone` instead of `email`:

```javascript
// Old way (email):
{ email: "user@example.com", password: "password" }

// New way (phone):
{ phone: "01095336760", password: "11223344" }
```

## Notes
- ✅ Phone login is **already implemented** in the backend
- ✅ Backward compatibility with email login is maintained
- ✅ Admin user with phone 01095336760 is created and ready
- 🔄 Just update your frontend to send `phone` field instead of `email`
