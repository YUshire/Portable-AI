import crypto from 'node:crypto';
const derive = (password, salt) => crypto.scryptSync(password, salt, 32);
export function seal(key, password) {
  if (password.length < 8) throw new Error('保存密钥的密码至少需要 8 个字符');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(password, salt), iv);
  const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return { version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function unseal(vault, password) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', derive(password, Buffer.from(vault.salt, 'base64')), Buffer.from(vault.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(vault.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(vault.data, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new Error('解锁密码不正确或密钥文件已损坏'); }
}
