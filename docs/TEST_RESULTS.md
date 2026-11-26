# Sinov natijalari

## v17

- O‘n mavzuli grafik besh rakursda proyeksiya qilindi. 90° yon va yuqori rakurslar hamda uchta boshqa holatda kenglik va balandlik tekshirildi. Canvas orqali 232 tugunli grafik to‘rt rakursda chizildi.
- Mind map sinovlari dumaloq shakl, shoxni erkin sudrash, kattalashtirish hodisalari, shox qaydini ochish, bog‘lanishni saqlash va biriktirmalarni omborni qayta ochganda olishni qamrab oladi.
- Trash sinovlari faylni ko‘chirish, tiklash, o‘chirish va bir qayddagi boshqa fayllarni saqlashni qamrab oladi.
- Chromium ish muhitida mahalliy soket cheklovi sabab ochilmadi. Masofaviy brauzer mahalliy test serveriga ulanmay qoldi. Safari va Mac trackpad’da amaliy sinov o‘tkazilmadi.

## v16

- 25 ta Python testi, jumladan, `print("olma")` HTTP orqali ishlashi, ombor qulfi va token tekshiruvi, SQLite ma’lumotlari har urinishda yangidan yaratilishi, chiqish va vaqt chegaralari.
- 12 ta JavaScript testi. Kod tilini aniqlash, Run va Copy boshqaruvlari, natija chiqishi, to‘qqiz shakl turini tanish, ushlab turish va saqlash sinovlari bor. Chizma hodisalari Canvas va DOM o‘rinbosarlari bilan sinovdan o‘tdi.
- ZIP alohida papkaga ochildi. Terminal buyrug‘i to‘liq yo‘l orqali `--help` bilan tekshirildi. macOS Finder va Apple Pencil qurilmasida sinov o‘tkazilmadi.

## Dastlabki v13

`PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -v` orqali 9 ta test o‘tdi. Dastlabki ishga tushirish 3,059 soniya davom etdi.

## v15

- 21 ta Python testi. API orqali xarita yaratish, o‘zgartirish, qayta import va ko‘chma ZIPni o‘qish sinovlari bor. Omborni qayta ochish, shifrlash va eski checksum bilan yozuvni rad etish tekshirildi.
- 7 ta JavaScript testi. Aralash papkadagi MOC, yangi qayd, mavzusi o‘xshash qayd, aloqalar masofasi, markazlar orasidagi farq va shox tahriri sinovlari bor. Muharrir testi DOM o‘rinbosaridan foydalanadi.
- Canvas chizish mexanizmi bilan 232 ta sun’iy tugun ko‘rildi. 7 mavzu guruhi va alohida mundarija hosil bo‘ldi. Turli foydalanuvchilarning to‘liq omborlarida o‘lchash keyingi sinovga kiradi.
- Ish muhitida Chromium jarayoni mahalliy soket cheklovi sababli ishga tushmadi. Safari, Chrome va mobil brauzerda to‘liq vizual sinov ochiq.

## v14

| Sinov | Buyruq | Natija |
|---|---|---|
| Python regressiya | `python -m unittest discover -s tests -v` | 18 ta o‘tdi |
| Frontend DOM shartlari va grafik mantiqi | `node --test tests/test_frontend.mjs` | 3 ta o‘tdi |
| JavaScript sintaksisi | `node --check` birinchi tomon JS modullari | O‘tdi |
| ZIP tiklash | `test_portable_roundtrip` | Asl fayl baytlari, bog‘lanish, qayd ID, koordinata, sevimli va tarix saqlandi |
| Uzilgan migratsiya | `test_failed_schema_migration_rolls_back`, `test_legacy_merge_conflicts_malformed_and_failed_transaction` | Qisman yozuv qolmadi, qayta urinish o‘tdi |
| Kirish va yaxlitlik | `test_corrupted_entity_ciphertext_is_rejected` va agent testlari | Shikastlangan qiymat va agentga berilmagan tasdiq rad qilindi |
| Eski brauzer qiymatlari | Import, ikki qayta urinish va qayta ochish | Omborning yangi qiymati saqlandi. Tiklangan bo‘sh xususiyat qayta to‘ldirilmadi |
| Tashqi import | `test_import_zip_obsidian_notion_and_rejected_invalid_paths` | Alias, teg, HTML/CSV va noto‘g‘ri yo‘l regressiyasi o‘tdi |
| Katta grafik CPU | `node benchmarks/measure_graph.mjs web` | [O‘lchovlar](GRAPH_PERFORMANCE.md) |

Sinov muhiti Python 3.12.14, cryptography 50.0.0, PyYAML 6.0.3 va Node.js v24.22.3. Grafik yuzasi o‘rinbosar Canvas bilan ishlaydi. Qayd tahrirlash va real UI responsive sinovi, mobil/screen reader, GPU, brauzer FPS va mustaqil xavfsizlik auditi ushbu muhitda bajarilmadi.
