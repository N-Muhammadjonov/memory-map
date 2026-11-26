# Ijro hisoboti

Loyiha — v17 asosidagi v18 Batch 1. Baseline ZIP SHA-256 `19d5768b342c09a01be29d3e53313a3763f18595c037cb22fe31316434aaad13`. Asl arxiv saqlangan. Mahalliy qaytish nuqtasi `edd5ad8d15b5b14be6746564dd410517dc20c00e` va asl v17 ZIP.

| Band | Asl sabab va dalil | O‘zgargan joy | Avtomatik dalil | Brauzer |
|---|---|---|---|---|
| T01 | `VERIFIED_CODE` Tahrirlanmaydigan rasm yagona blok bo‘lib qolganida caret uchun paragraf yo‘q edi. Qo‘shni matn bilan bir qator oralig‘ida turgan rasm ayrim hollarda matn paragrafida qolardi. | `web/notion-editor.js` → `markdownToDocHtml`, `ensureImageBoundaries`, `handleImageBoundaryKey`, `docDomToMarkdown` | `VERIFIED_AUTOMATED` Bir va ikki rasmli Markdown, uch takroriy tekshiruv, bo‘sh alt va bo‘sh paragrafni yozuvga qo‘shmaslik. HTTP orqali UTF-8 matn va rasm ID’si eksportdan tiklandi. | BROWSER_BLOCKED |
| T02 | `VERIFIED_CODE` Uzun sarlavhalar uchun ichki tab scroll bor edi. Har bir ekran uchun bitta qatorda qolgan boshqaruvlar va bolalar elementlarining minimal eni chizilgan chegaradan chiqishi mumkin edi. Foydalanuvchi xabar bergan piksel natijalari bu yerda qayta o‘lchanmagan. | `web/app.js` → `placeWorkspaceActions`, `setView`. `web/index.html` → `file-menu`. `web/styles.css` → bosh panel, rasm, viewer va responsiv split. | `VERIFIED_CODE` Bir xil tugunlar tor oynada More menyusiga ko‘chadi. Asosiy kod va DOM ID sinovlari o‘tdi. Piksel va bosish dalillari ochiq. | BROWSER_BLOCKED |
| T03 | `VERIFIED_CODE` Slayder umumiy 7×9 px padding va 76 px kenglik bilan ishlardi. | `web/styles.css` → `.draw-range`. `web/index.html` → `draw-size`. `web/note-tools.js` → `setupDrawing`. | `VERIFIED_AUTOMATED` Qiymatlar 1, 10, 20 boshqaruvdan stroke modeliga va saqlashga uzatildi. Haqiqiy pointer va touch chegaralari ochiq. | BROWSER_BLOCKED |
| T04 | `VERIFIED_CODE` Edit va Delete tugmalarida handler bo‘lmagan. Saqlash faqat create marshrutiga ketgan. | `web/app.js` → `withViewerDrawing`, `loadDrawingDraft`, `showDrawing`, `deleteViewerDrawing`. `web/note-tools.js` → mavjud draft, qayta yuklash. `vault.py` → aniq chizma havolasi. | `VERIFIED_AUTOMATED` O‘zgarmagan fayl ID va yangi PNG, legacy rev 0, ikkala turdagi 409, autentifikatsiyasiz 401, faqat tanlangan rasmni o‘chirish va qo‘shni matnni saqlash. UI Cancel va xato holati hali brauzerda tekshirilmagan. | BROWSER_BLOCKED |
| T05 | `VERIFIED_CODE` CSS kenglikni 100% qilib, balandlikni alohida qisqartirgan. Legacy PNG to‘liq 1200×720 maydonga cho‘zilgan. | `web/styles.css` → `#draw-dialog`, `#draw-surface`. `web/note-tools.js` → `redraw` va avvalgi coordinate mapping. | `VERIFIED_AUTOMATED` 1× va o‘zgargan display scale’da burchak va markaz koordinatalari, 720×720 legacy rasmning proporsional joylashuvi, resize’dan keyingi stroke saqlanishi. DOM nisbati haqiqiy brauzerda ochiq. | BROWSER_BLOCKED |

## Gate 1 — PARTIAL

- Python 29/29, JavaScript 16/16. Bash launcher, JavaScript sintaksisi va ZIP yaxlitligi tekshirildi.
- Test omboridan olingan ko‘chma ZIP yangi faylga tiklandi. Qayd tanasi, rasmning SHA-256 xeshi va chizma yozuvi taqqoslandi. Test manbasi `tests/test_batch1_workflow.py`.
- Brauzer ishga tushirish urinishida Chromium mahalliy soket uchun `Operation not permitted` qaytardi. Playwright WebKit binary topilmadi. Haqiqiy oldin/keyin skrinshotlari, 320–1440 px metrikalari va Safari/iOS gesture natijalari mavjud emas. [Ishga tushirish jurnali](QA_EVIDENCE/browser-launch.txt).
- T01–T05 kodi o‘zgartirilgan. Ularning yakuniy brauzer qabul mezonlari ochiq. T06–T25 boshlanmagan.
- Keyingi amal — [brauzer qabul sinovlarini](QA_EVIDENCE/BROWSER_CHECKLIST.md) sintetik omborda ishga tushirish. Gate 1 ochilgandan keyingi beshlik T06–T10.

## Joriy arxitektura va qaytish

Rich editor ichidagi bo‘sh rasm chegaralari Markdown saqlashiga kirmaydi. Rasm manzili va qayd saqlash zanjiri avvalgi formatda. Tahrir viewer’dan olingan note ID va attachment ID bilan aynan bitta chizmani so‘raydi. Saqlashdagi `revision` chizmaga, o‘chirishdagi `revision` egasi bo‘lgan qaydga tegishli. To‘qnashuvda tahrir qoralamasi dialogda qoladi va mavjud saqlangan nusxani qayta ochish uchun aniq tanlov chiqadi.

T01–T03 va T05 uchun ma’lumot migratsiyasi yo‘q. T04 mavjud marshrutlar va shifrlangan yozuvlardan foydalanadi. Rollback uchun v17 arxivini boshqa papkada oching yoki mahalliy toza baseline commitidan checkout qiling. Ishlab turgan ombor uchun bir vaqtda bitta ilova nusxasini oching. Ilova versiyasini qaytarish foydalanuvchi qabul qilgan tahrirlarni qaytarmaydi. Testlar faqat vaqtinchalik sintetik omborlarda ishlagan.

## Keyingi baholash uchun tayyor ssenariylar

| Ssenariy | O‘lchov | Isbot holati |
|---|---|---|
| Rasmli qaydga kontekst kiritish va qayta ochish | Bajarish vaqti, qayta urinishlar, saqlangan matn va rasm ID’si | Avtomatik dalil bor, brauzer va foydalanuvchi sinovi ochiq |
| Chizmani tahrirlash, to‘qnashuvdan keyin qayta yuklash va asl ID’ni tekshirish | Saqlangan fayl, xato bilan ishlash, qayta ochish vaqti | HTTP dalil bor, brauzer va foydalanuvchi sinovi ochiq |
| Hujjatdan dalil topish va qaydga havola qo‘yish | Manba aniqligi, vaqt, xatolar | Rejalashtirilgan |

Bozor qiymati, foydalanuvchi soni, daromad yoki raqiblardan ustunlik bo‘yicha yangi o‘lchov mavjud emas. Bu hujjat texnik dalil paketidir.
