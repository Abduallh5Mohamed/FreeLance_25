// Clear all demo/development data from localStorage
console.log('🧹 Clearing demo data from localStorage...');

try {
    // Clear auth tokens
    localStorage.removeItem('authToken');
    localStorage.removeItem('dev-token');

    // Clear user data
    localStorage.removeItem('currentUser');
    localStorage.removeItem('currentStudent');
    localStorage.removeItem('supabaseUser');

    // Clear any session data
    localStorage.removeItem('student_session');

    console.log('✅ Demo data cleared successfully!');
    console.log('Please refresh the page and login properly.');
} catch (error) {
    console.error('❌ Error clearing data:', error);
}
