import bcrypt from 'bcrypt';

const password = 'Mtd#mora55';
const hash = await bcrypt.hash(password, 10);
console.log('Hash:', hash);
