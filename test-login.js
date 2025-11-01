async function testLogin() {
    try {
        const response = await fetch('http://localhost:3001/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone: '01024083057',
                password: 'Mtd#mora55'
            })
        });

        const data = await response.json();

        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(data, null, 2));

        if (response.ok) {
            console.log('\n✅ Login successful!');
            console.log('User:', data.user.name);
            console.log('Role:', data.user.role);
            console.log('Token:', data.token.substring(0, 20) + '...');
        } else {
            console.log('\n❌ Login failed!');
            console.log('Error:', data.error);
        }
    } catch (error) {
        console.error('❌ Request failed:', error.message);
    }
}

testLogin();
