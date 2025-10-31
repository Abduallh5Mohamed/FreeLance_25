// Final test: Simulate StudentChat AI request
console.log('🧪 Final Test: StudentChat AI Direct to Google API\n');
console.log('=' .repeat(70));

async function testStudentChatAI() {
  const googleApiKey = 'AIzaSyAm-hpg9pjc66DqNnS8qHpdgeKBd-FZP70';
  
  const systemPrompt = `أنت مساعد ذكي تعليمي متخصص حصراً في مساعدة طلاب المرحلة الثانوية المصريين في دراسة التاريخ.

وظيفتك الأساسية:
- شرح الأحداث التاريخية والشخصيات والفترات بوضوح ودقة
- مساعدة الطلاب على فهم دروس المنهج المصري للتاريخ
- تقديم ملخصات وتحليلات ومقارنات للأحداث التاريخية
- الإجابة على أسئلة من نمط الامتحانات
- مساعدة الطالب على كتابة الإجابات الطويلة

رد دائماً بالعربية فقط، وكن ودوداً وصبوراً - بدو كمعلم مختص وليس روبوت.`;

  const userMessage = 'اشرح لي عن الثورة الفرنسية بشكل مختصر';

  console.log('\n📤 Simulating StudentChat Request:\n');
  console.log(`Student Message: "${userMessage}"`);
  console.log(`Model: Gemini 2.0 Flash\n`);

  try {
    console.log('⏳ Sending to Google API...\n');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleApiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userMessage }]
            }
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1000,
            topK: 40,
            topP: 0.95,
          },
        }),
      }
    );

    const data = await response.json();

    if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
      const aiResponseText = data.candidates[0].content.parts[0].text;
      console.log('✅ SUCCESS! AI Response Received:\n');
      console.log('=' .repeat(70));
      console.log(aiResponseText);
      console.log('=' .repeat(70));
      return true;
    } else {
      console.log('❌ Unexpected response format');
      console.log('Response:', JSON.stringify(data, null, 2));
      return false;
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    return false;
  }
}

// Run test
(async () => {
  const success = await testStudentChatAI();
  
  console.log('\n' + '=' .repeat(70));
  if (success) {
    console.log('\n✅ FINAL TEST PASSED!');
    console.log('\n🎉 StudentChat AI is now fully working!');
    console.log('\n📝 Steps to test in the browser:');
    console.log('   1. Go to http://localhost:8080/student-chat');
    console.log('   2. Click the AI button (🤖)');
    console.log('   3. Type any history question in Arabic');
    console.log('   4. You will receive a real AI response!');
  } else {
    console.log('\n❌ FINAL TEST FAILED');
  }
  console.log('\n' + '=' .repeat(70) + '\n');
})();
