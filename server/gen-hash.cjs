const bcrypt = require('bcryptjs');

const password = 'Mtd#mora55';
bcrypt.hash(password, 10).then(hash => {
    console.log('Password Hash:');
    console.log(hash);
});
