# Mahsulot strategiyasi va yo‘l xaritasi (v23)

Bu hujjat kod, testlar va README dan olingan faktlarga asoslangan. Bozor o‘lchovi, foydalanuvchi soni yoki daromad bo‘yicha dalil yo‘q.

## Hozirgi holat (kodda tasdiqlangan)

- Shifrlangan mahalliy ombor (AES-GCM, Argon2id), Python server + brauzer UI, bitta qurilma.
- Bor: Markdown/rich muharrir, 3D graf, mind map, jadval/Kanban/kalendar, roadmap, flashcards, chizma, kod bloklari, PDF ko‘rish, mahalliy AI agent API, shifrlangan zaxira.
- Yo‘q: hisoblar, sinxronlash, ommaviy havola, hamkorlik, mobil ilova, Windows (`fcntl` faqat macOS/Linux), o‘rnatuvchisiz ishga tushirish (Python kerak).

## Raqobatchilarga nisbatan

| Mezon | Xotira hozir | Notion | Obsidian | Word | Mind map ilovalari |
|---|---|---|---|---|---|
| Mahalliy + shifrlangan | Ha | Yo‘q | Ha (shifrsiz) | Qisman | Ba’zilari |
| Graf + mind map + qayd bitta joyda | Ha | Yo‘q | Graf bor, mind map plagin | Yo‘q | Faqat xarita |
| Sinxronlash | Yo‘q | Ha | Pullik | OneDrive | Ha |
| Ommaviy sahifa / hamkorlik | Yo‘q | Ha | Pullik | Ha | Ha |
| Mobil | Faqat brauzer | Ha | Ha | Ha | Ha |

Haqiqiy ustunlik hozircha bitta: **shifrlangan mahalliy xotira + graf + mind map + AI agent uchun ochiq API** bir joyda. Qolgan qatorlarda Xotira ortda.

## Tavsiya etilgan ketma-ketlik

1. **Veb/PWA va o‘rnatuvchisiz ishga tushirish** (Python talab qilmaydigan paket yoki brauzerda ishlaydigan versiya). Windows qo‘llovi.
2. **E2EE sinxronlash** (qurilmalar orasida). Server faqat shifrlangan blob saqlaydi.
3. **Ommaviy sahifa** (bitta qaydni statik HTML sifatida nashr qilish, havola bilan ulashish).
4. **Hamkorlik** (taklif qilingan foydalanuvchilar, ruxsatlar).
5. **Birinchi 20–50 haqiqiy foydalanuvchi** va ularning ishlatish ma’lumoti. Investor uchun asosiy dalil shu.

## Ochiq qaror

Sinxronlash arxitekturasi qaysi yo‘nalishda bo‘lishi kerak?

- **A. Local-first + E2EE sync.** Maxfiylik bilan ajralib turadi, Obsidian/Notion o‘rtasidagi bo‘sh joy. Real-time birgalikda tahrirlash qiyinroq (CRDT kerak).
- **B. Server-first (Notion kabi).** Hamkorlik va ommaviy sahifa oson, lekin shifrlangan mahalliy ustunlik yo‘qoladi.

Tavsiya: A bilan boshlash, ommaviy sahifani alohida «nashr qilish» amali sifatida qo‘shish.
