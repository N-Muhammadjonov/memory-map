# Xavf modeli

| Xavf | Hozirgi himoya | Qolgan holat |
|---|---|---|
| Disk yoki zaxira fayliga ruxsatsiz kirish | Argon2id paroldan kalit oladi. AES-GCM yukni ombor, yozuv va talqinga bog‘laydi | SQLite ID, o‘lcham va talqin kabi strukturaviy ma’lumotlar ko‘rinadi |
| Mahalliy serverga boshqa origin murojaati | Loopback, Host, Origin, token, Content Security Policy | Ochiq OS sessiyasi, brauzer kengaytmasi yoki mahalliy jarayon uchun alohida ishonch chegarasi bor |
| Agent kalitidan ruxsatsiz yozish | Agent kaliti bilan yozuv taklif etiladi. Egasi tasdiqlaydi. Yozuv imkonini o‘chirish yoki kalitni yangilash mumkin | O‘qish kaliti ochiq omborni o‘qishi mumkin. Takliflar tarixi doimiy audit logiga yozilmaydi |
| Yozuv to‘qnashuvi va takroriy tasdiq | Talqin tekshiruvi, tranzaksiya, tasdiqlangach taklif IDsi iste’mol qilinadi | Qurilmalararo to‘qnashuvni birlashtirish mavjud emas |
| Importdagi yo‘l va katta arxiv | ZIP a’zolari diskka shu nomdan chiqarilmaydi. Noto‘g‘ri yo‘l, symlink, takroriy yo‘l, hajm va a’zolar soni tekshiriladi | Murakkab ZIP va parsers bo‘yicha tashqi fuzzing chiqqan relizdan oldingi vazifa |
| Ma’lumotning tasodifiy oshkor bo‘lishi | Birinchi migratsiya zaxirasi shifrlangan. Qidiruv indeksi qulfda RAMdan bo‘shatiladi | Ko‘chma ZIPning Markdown/JSON qismi ochiq. Brauzerdagi faol tizim, kesh yoki operatsion xotira alohida xavf |
| Noto‘g‘ri migratsiya yoki shikastlanish | Snapshot, bitta sxema tranzaksiyasi, AES-GCM tekshiruvi va tiklash jarayoni | Oflayn shifrlangan replikatsiya, kalit rotatsiyasi va rasmiy xavfsizlik auditi keyingi bosqichda |

Bog‘liq manbalar [SQLite Backup API](https://sqlite.org/backup.html), [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [PyYAML hujjatlari](https://pyyaml.org/wiki/PyYAMLDocumentation).
