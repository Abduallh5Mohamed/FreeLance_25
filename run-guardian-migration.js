import axios from 'axios';

async function runMigration() {
    try {
        console.log('🚀 Running guardian_phone migration on server...\n');

        // Call the migration endpoint
        console.log('📡 Sending request to http://72.62.35.177/api/migrations/run-guardian-migration\n');

        const response = await axios.post(
            'http://72.62.35.177/api/migrations/run-guardian-migration',
            {},
            { timeout: 30000 }
        );

        console.log('✅ Migration completed!\n');
        console.log('📋 Results:');
        console.log(JSON.stringify(response.data, null, 2));
        console.log('');

        if (response.data.success) {
            console.log('==========================================');
            console.log('✅✅✅ SUCCESS! Migration applied successfully!');
            console.log('==========================================\n');

            console.log('📝 Summary:');
            console.log(`   Students table: ${response.data.results.students.exists ? 'Already had' : 'Added'} guardian_phone column`);
            console.log(`   Registration requests table: ${response.data.results.registration_requests.exists ? 'Already had' : 'Added'} guardian_phone column`);
            console.log('');

            console.log('🔄 Now you can:');
            console.log('   1. Create a new account with guardian phone');
            console.log('   2. The guardian phone will be saved correctly');
            console.log('   3. Check the offline students page to see the number');
        } else {
            console.log('❌ Migration failed!');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

runMigration();
