// Ambiente determinístico para testes. Nenhuma credencial real é usada.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.LOG_LEVEL = 'silent';
process.env.AUTO_SYNC_ENABLED = 'false'; // nos testes ninguém sincroniza sozinho
process.env.RATE_LIMIT_LOGIN_MAX = '20';
process.env.UPLOAD_DIR = './storage-test/anexos';
process.env.RH_STORAGE_DIR = './storage-test/rh';
