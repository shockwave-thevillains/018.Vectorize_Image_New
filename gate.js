/* Vektor — gerbang kata sandi.
   Kata sandi tidak disimpan; yang disimpan hanya hasil hash bertingkat:
     1. SHA-512(kata sandi ‖ garam1)
     2. PBKDF2-HMAC-SHA-512(hasil 1, garam2, 600000 putaran)
     3. SHA-256(hasil 2 ‖ garam1)
   Aplikasi (app.js) baru dimuat setelah hash cocok. Diminta setiap kali laman dibuka. */
const S1 = '7aceb4f8dc6dd731f8624668cefbc62aa078c3d3ee360b80de88ee7da3196548';
const S2 = '266b1fdbdfbdac55c9bc3026f7fbecb3b433df6ae181536f1c202932138c4b8f';
const ITER = 600000;
const HASH = '4dbad1b2fafb889f89b74ffa5c78bffdbd5b860712e948da94051d00578bd6e8';

const fromHex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const toHex = (b) => Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('');
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

async function derive(pw) {
  const s1 = fromHex(S1);
  const l1 = new Uint8Array(await crypto.subtle.digest('SHA-512', cat(new TextEncoder().encode(pw), s1)));
  const key = await crypto.subtle.importKey('raw', l1, 'PBKDF2', false, ['deriveBits']);
  const l2 = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: fromHex(S2), iterations: ITER }, key, 512));
  return toHex(await crypto.subtle.digest('SHA-256', cat(l2, s1)));
}
// Perbandingan waktu-konstan.
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const form = document.getElementById('gateForm');
const input = document.getElementById('gatePw');
const btn = document.getElementById('gateBtn');
const msg = document.getElementById('gateMsg');
let fails = 0, waitUntil = 0;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (Date.now() < waitUntil || btn.disabled) return;
  const pw = input.value;
  if (!pw) { input.focus(); return; }
  btn.disabled = true; input.disabled = true;
  msg.className = 'gate-msg'; msg.textContent = 'Memeriksa…';
  let ok = false;
  try { ok = same(await derive(pw), HASH); } catch { msg.textContent = 'Browser ini tidak mendukung pemeriksaan kata sandi (butuh HTTPS).'; }
  if (ok) {
    input.value = '';
    msg.textContent = 'Membuka…';
    await import(`./app.js${new URL(import.meta.url).search}`);
    document.documentElement.classList.remove('locked');
    document.getElementById('gate').remove();
    return;
  }
  fails++;
  // Jeda bertambah tiap salah: 1, 2, 4, … maks 30 detik.
  const wait = Math.min(30, 2 ** (fails - 1));
  waitUntil = Date.now() + wait * 1000;
  input.value = '';
  msg.className = 'gate-msg err';
  const tick = () => {
    const left = Math.ceil((waitUntil - Date.now()) / 1000);
    if (left > 0) { msg.textContent = `Kata sandi salah. Coba lagi dalam ${left} dtk.`; setTimeout(tick, 250); return; }
    msg.textContent = 'Kata sandi salah.';
    btn.disabled = false; input.disabled = false; input.focus();
  };
  tick();
});
input.focus();
