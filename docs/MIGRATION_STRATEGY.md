# Migratsiya va qaytarish

1. v13 omborini yangi dastur bilan odatdagi parol orqali oching. SQLite struktura o‘zgarishidan oldin ombor yoniga `*.pre-structure-*.xotira` nomli shifrlangan snapshot yoziladi. Nusxa yaratish muvaffaqiyatsiz bo‘lsa, migratsiya boshlanmaydi.
2. Yangi jadvallar bitta SQLite tranzaksiyasida ochiladi. Eski jadvallar, qayd formati va parol saqlanadi. Mavjud `application_id` va `user_version` v13 bilan bir xil.
3. Eski brauzer originidagi `xotira-v13-note-meta` topilsa, yangi dastur uni ombor ochilgach o‘qiydi. `status`, `priority`, `due`, `icon`, `cover` maydonlari faqat shu IDga tegishli qaydga ko‘chadi.
4. Ombordagi qiymat ustun turadi. Takroriy urinish maydonlarni qayta tatbiq qilmaydi, shu jumladan tarixdan bo‘sh xususiyatlar tiklanganda. Ko‘chgan maydonlar qaydi shifrlangan. Yaroqsiz qiymatlar, topilmagan qaydlar va farqlar hisoblanadi. Eski brauzer yozuvi saqlanadi.
5. Uzilishda tranzaksiya va xotiradagi holat oldingi qiymatlarda qoladi. O‘sha JSONni qayta yuborish mumkin.

## Eski port yoki profil

Brauzer ma’lumotni `http://127.0.0.1:PORT` originiga va profilga bog‘laydi. Yangi tasodifiy port yoki boshqa profil eski qiymatlarni ko‘ra olmaydi. Eski portni bilsangiz, dastur ochiq bo‘lmagan vaqtda o‘sha profilga qayting va `sh start.command --port ESKI_PORT` bilan ishga tushiring. Bir nechta portda ishlagan bo‘lsangiz, ularni alohida ko‘rib chiqing.

Eski origin ochiq paytda, brauzer ishlab chiquvchi vositalarining Storage bo‘limidan `xotira-v13-note-meta` qiymatini nusxalab, UTF-8 JSON fayliga saqlashingiz mumkin. Keyin yangi omborda Fayl → Eski qayd xususiyatlarini import qilish orqali yuklang. Shu ma’lumotni saqlagan brauzer profili topilmasa, omborning o‘zida v13 xususiyatlarini tiklashga yetarli ma’lumot yo‘q.

## Qaytarish

`*.pre-structure-*.xotira` faylini alohida nomga nusxalang va v13 dasturini o‘sha fayl bilan `--vault` orqali ishga tushiring. Bu nusxa migratsiyadan oldingi holatni ko‘rsatadi. Keyingi tahrirlar uchun joriy omborni ham saqlang. v13 yangi jadvallarni ishlatmaydi. Eski dastur orqali yozishni davom ettirsangiz, v14 tarixi yangi yozuvlarni tutib bormaydi.

To‘liq ko‘chma eksportdan tiklash faqat yangi manzilga ishlaydi. SQLite `quick_check` va `foreign_key_check`dan so‘ng fayl yaratiladi. Parol va yozuvlarning shifrlangan yaxlitligi ombor ochilganda tekshiriladi.
