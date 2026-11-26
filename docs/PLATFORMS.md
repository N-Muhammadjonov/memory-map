# Platformalar: nima bor, nima yo‘q va yo‘l xaritasi (v27)

## Hozir (tekshirilgan)
| Platforma | Holat |
|---|---|
| Linux | Dastur qurilgan va brauzerda tekshirilgan (`tests/smoke_binary.py`). |
| Windows | Kod moslangan (blokirovka, papka, `start.bat`), workflow bor. Haqiqiy Windows'da sinalmagan. |
| macOS | Workflow bor. Sinalmagan. Imzosiz dastur: «noma'lum dasturchi» ogohlantirishi chiqadi. |
| Android / iPhone | **Yo‘q.** Hozirgi ilova kompyuterda Python serveri bilan ishlaydi; telefonda bunday server ishlamaydi. |

Foydalanuvchi uchun oqim: GitHub Releases → «Download» (`site/index.html` sahifasi to‘g‘ri faylni topib beradi) → ikki marta bosish. Hozircha dastur ochilganda konsol oynasi ham chiqadi; yopsangiz dastur to‘xtaydi.

## Telefon: haqiqat
- **iPhone'ga GitHub'dan o‘rnatib bo‘lmaydi.** iOS faqat App Store yoki TestFlight (Apple Developer, yiliga $99) orqali o‘rnatadi. Arzon yo‘l: veb-ilova (PWA) — Safari'da havola ochilib «Add to Home Screen».
- **Android** APK'ni GitHub'dan yuklab o‘rnatish mumkin (sideload), lekin avval ilovaning yadrosi telefonda ishlashi kerak.
- Ikkalasi uchun ham **yadroni brauzerda ishlaydigan qilish** kerak: shifrlash (WebCrypto + Argon2id WASM), saqlash (IndexedDB/SQLite-WASM) va hozirgi Python serverining mantig‘i (qaydlar, graf, qidiruv, import, ulashish) JavaScript/TypeScript'ga ko‘chiriladi. UI deyarli o‘zgarmaydi: `/api/*` so‘rovlarini kutubxona brauzer ichida javoblaydi. Bu katta ish (bir necha sessiya), lekin shundan keyin bitta kod Cloudflare Pages'da PWA bo‘lib, Capacitor orqali Android APK va iOS (TestFlight) bo‘ladi.

## Xizmatlar
- **Cloudflare** yetarli: Pages (sayt + PWA), Workers + D1 (statistika), R2 (kerak bo‘lsa fayllar). Vercel qo‘shimcha qiymat bermaydi, ikki sotuvchi murakkablik qo‘shadi.
- **Supabase** hozir kerak emas. Hisoblar va qurilmalar orasida shifrlangan sinxronlash qo‘shilganda ma’qul tanlov bo‘ladi (serverda faqat shifrlangan blob).

## Tavsiya etilgan tartib
1. (Tayyor) Desktop dasturlari + statistika + yuklab olish sahifasi → 5–20 sinovchi.
2. Brauzer yadrosi (Phase 2) → PWA (iPhone/Android/hamma joyda havola bilan).
3. Capacitor: Android APK GitHub'da, iOS TestFlight.
4. Kod imzolash (Windows sertifikat, Apple Developer) — ishonch ogohlantirishlari yo‘qolishi uchun.
