import http from 'http';

const data = JSON.stringify({
    phone: '01095336760',
    password: '11223344'
});

const options = {
    hostname: 'localhost',
    port: 3001,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
    }
};

const req = http.request(options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    
    let body = '';
    res.on('data', (chunk) => {
        body += chunk;
    });
    
    res.on('end', () => {
        console.log('Response:', body);
        try {
            const json = JSON.parse(body);
            console.log('Parsed:', JSON.stringify(json, null, 2));
        } catch (e) {
            console.log('Raw response:', body);
        }
    });
});

req.on('error', (e) => {
    console.error(`Error: ${e.message}`);
});

req.write(data);
req.end();
