HOSTINGER DEPLOYMENT INSTRUCTIONS
==================================

1. Upload Files:
   - Upload public_html/* to your public_html folder
   - Upload api/* to a folder named 'api' in root
   - Keep database folder for later use

2. Setup MySQL Database:
   - Create new MySQL database in Hostinger
   - Import database/mysql-schema.sql
   - Import other SQL files if present

3. Configure .env:
   - Edit api/.env with your database credentials
   - Change JWT_SECRET and SESSION_SECRET

4. Install Dependencies via SSH:
   cd ~/api
   npm install --production

5. Start Application:
   - Use Node.js Selector in Hostinger
   - Or use PM2: pm2 start index.js

Default Login:
Phone: 01024083057
Password: Mtd#mora55

CHANGE PASSWORD AFTER FIRST LOGIN!
