# Xotira v19

## Kundalik ish jarayoni

| Ish | v19 dagi yechim | Tekshiruv |
|---|---|---|
| Kalendar va eslatma | Har bir qaydning muddati va eslatmasi bitta taqvimda. Tanlangan kundan tadbir yaratiladi. Muddati kelgan eslatmadan qayd ochiladi. | Kabisa kuni, mahalliy vaqt, eslatmani o‘qish va tiklash, eski tahrir to‘qnashuvi va .ics signalini avtomatik tekshirish |
| Kurs va loyiha progressi | Qayd ichidagi ikkinchi darajali sarlavhalar bosqichlarga aylanadi. Bog‘langan vazifa qaydlari ham hisobga kiradi. Foiz tugallangan vazifalar sonidan hisoblanadi. | Ikki tomonlama bog‘lanishni bir marta hisoblash, haqiqiy vazifani yangilash, kod ichidagi soxta vazifani chetlab o‘tish |
| Qayd ichida vizual ish | Biriktirmalar o‘ng panelda, xarita yaratish yuqori qatorda. Bitta qaydda matn, chizma, hujjatlar va mind map birga ishlaydi. | Shakl boshlangan koordinata, birinchi bosish, Undo va Redo uchun avtomatik sinov. Fayl paneli va xarita uchun brauzer ssenariysi |
| Tugmalar va rang | Asosiy amal, tanlangan holat va ko‘chirish ranglari ajratildi. Trash nishoni ko‘k rang olib kattalashadi. Chizma strelkalari va eslatma qo‘shimchalari yorliqli. | CSS qoidalari va brauzer ssenariysi |

Kalendar sanaga asoslangan ko‘rinishdan, roadmap esa bog‘lanish orqali hisoblangan progressdan foydalanadi. Natijada kurs bosqichlari uchun alohida jadvalga foiz kiritish shart bo‘lmaydi. Kalendar fayliga standart iCalendar eslatmasi qo‘shiladi. Uni import qiladigan dastur signalni o‘z sozlamalariga ko‘ra boshqaradi. [Kalendar](https://www.notion.com/help/calendars) · [Bog‘lanish va yig‘ma qiymatlar](https://www.notion.com/help/relations-and-rollups) · [iCalendar](https://www.rfc-editor.org/rfc/rfc5545.html)

Mahsulotning sinovga arziydigan ustunligi — mavzu bo‘yicha yig‘ilgan qaydlar, qo‘lda chizilgan diagramma, kurs rejasi va eslatma bitta mahalliy omborda ishlashi. Buni o‘lchash uchun haqiqiy foydalanuvchiga bir kursni olib kirish, bir bosqichni bajarish, qaydni eslatmadan ochish va yangi nusxada zaxirani tiklash vazifasini bering. Sarflangan vaqt, yo‘qolgan ma’lumot, takror foydalanish va to‘lovga tayyorlikni yozib boring.

## Xavfsizlik

| Tahdid | Himoya | Himoya chegarasi |
|---|---|---|
| Ombor faylini nusxalash | Qaydlar, biriktirmalar va eslatmalar AES-GCM bilan shifrlanadi. Paroldan kalit Argon2id orqali olinadi. Yangi ombor fayli 0600 rejimida yaratiladi. | Zaif parolni o‘g‘irlangan nusxada mustaqil ravishda sinash mumkin. SQLite tuzilmasi ayrim yozuvlarning mavjudligi va taxminiy hajmini ko‘rsatadi. |
| Begona veb-sahifadan lokal API so‘rovi | Server loopback manzilida ishlaydi. Host va Origin tekshiriladi, API so‘rovida sessiya kaliti talab qilinadi. Brauzer so‘rovi cross-site deb belgilansa rad etiladi. | Operatsion tizimda ishlaydigan jarayon bilan brauzerdagi sayt turli ruxsatga ega. Lokal jarayonlar uchun asosiy to‘siq kalit va operatsion tizim ruxsatlaridir. |
| Agentga berilgan kalit | Agent API o‘chiq boshlanadi. Yoqilganda o‘qish ruxsati beriladi. Yozish alohida yoqiladigan va egasi tasdiqlaydigan taklif. Kalit qulflashda va o‘chirishda bekor qilinadi. Agent so‘rovlari avtoqulf vaqtini uzaytirmaydi. | O‘qish ruxsati ochiq ombordagi agent API orqali chiqadigan qaydlarni qamraydi. Agent ko‘rib ulgurgan nusxani kalitni bekor qilish bilan qaytarib bo‘lmaydi. |
| OS darajasidagi zararli jarayon | Omborni qulflash va disk shifrlanishi ta’sir doirasini kamaytiradi. | Ekran, klaviatura, xotira yoki OS orqali ochiq sessiyaga kirish huquqi berilgan jarayon o‘sha ruxsat bilan ishlaydi. |
| Zaxira va eksport | Shifrlangan .xotira zaxirasi asl parolni talab qiladi. | Markdown, ko‘chma ZIP ichidagi ochiq eksportlar, PDF va .ics fayllari ombor himoyasidan tashqarida. .ics fayli qayd sarlavhasi va eslatma vaqtini o‘z ichiga oladi. Mahalliy importlar uchun vaqtinchalik fayllar OS disk himoyasiga tayanadi. |

Origin va Fetch Metadata tekshiruvlari brauzer orqali jo‘natilgan begona so‘rovni rad etadi. FileVault Mac diski o‘chiq yoki qulflangan holatdagi ma’lumotlar uchun alohida himoya qatlamini ta’minlaydi. [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) · [Apple FileVault](https://support.apple.com/guide/security/volume-encryption-with-filevault-sec4c6dc1b6e/web)

## Moslik va sinov holati

v19 eslatmalarni shifrlangan metadata yozuvlarida saqlaydi. Ombor sxemasini almashtirish talab qilinmaydi. Avvalgi dastur versiyasi ularni taqvimda ko‘rsatmaydi. Eslatma Trash ichida yashiriladi, qayd tiklanganda yana chiqadi. Omborni boshqa versiyada ochishdan avval shifrlangan zaxira nusxasini saqlash mumkin.

Python va JavaScript sinovlari brauzerda bosish, sudrash hamda ko‘rinishni o‘lchash ssenariysidan mustaqil. Ushbu muhit Chromium uchun mahalliy soket ochishni chekladi. Safari Mac, iOS va jismoniy trackpad uchun qabul sinovi ochiq. [Brauzer ssenariysi](../tests/browser/batch1.cjs)
