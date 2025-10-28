import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

(async () => {
  console.log('🔄 جاري إنشاء جدول خطط الاشتراك...');

  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'Freelance',
      charset: 'utf8mb4'
    });

    console.log('✅ تم الاتصال بنجاح!\n');

    // إنشاء جدول خطط الاشتراك
    await connection.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
        name VARCHAR(255) NOT NULL,
        duration_months INT NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    console.log('✅ تم إنشاء جدول subscription_plans\n');

    // إضافة خطط تجريبية
    await connection.query(`
      INSERT INTO subscription_plans (name, duration_months, price, description) VALUES
      ('باقة شهرية', 1, 500, 'اشتراك لمدة شهر واحد'),
      ('باقة ربع سنوية', 3, 1400, 'اشتراك لمدة 3 أشهر بخصم 7%'),
      ('باقة نصف سنوية', 6, 2700, 'اشتراك لمدة 6 أشهر بخصم 10%'),
      ('باقة سنوية', 12, 5000, 'اشتراك لمدة سنة كاملة بخصم 17%')
    `);

    console.log('✅ تم إضافة خطط الاشتراك التجريبية\n');

    // عرض الخطط
    const [rows] = await connection.query('SELECT * FROM subscription_plans');
    console.log('📊 خطط الاشتراك:');
    console.table(rows);

    await connection.end();
    console.log('\n✅ تم الانتهاء بنجاح!');
    process.exit(0);

  } catch (error) {
    console.error('❌ خطأ:', error.message);
    process.exit(1);
  }
})();
