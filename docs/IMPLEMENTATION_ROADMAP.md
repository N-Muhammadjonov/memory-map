# Bog‘liqliklarga asoslangan yo‘l xaritasi

| Bosqich | Kirish sharti | Ish va chiqish mezoni | Holat |
|---|---|---|---|
| 0 | Manba nusxasi | Audit, ZIP xeshi, v13 regressiya to‘plami, CPU bazasi | Yakunlangan |
| 1 | Barqaror ID va tiklanadigan ombor | Shifrlangan kanonik xususiyat, tranzaksiyali tarix, import va tiklash | Asosiy oqim va server sinovlari yakunlangan |
| 2 | Ko‘rinishlar bitta ma’lumot modelini o‘qiydi | Rich property, to‘liq Notion CSV va relatsiyalar, on-device semantik index, yaxshilangan katta grafik va mobil sinov | Qisman |
| 3 | Ikki parallel mahalliy foydalanuvchida konflikt sinovi | Mahalliy yozuv logi, imzolangan/shifrlangan operatsiyalar, qayta ijro, tiklanish, kalit boshqaruvi | Boshlanmagan |
| 4 | Tekshirilgan shifrlangan sync | Taklif, rollar, izoh, mentions, parallel tahrir, plugin ruxsati va API versiyalash | Boshlanmagan |
| 5 | Jamoaviy beta dalillari | Tashqi audit, SSO, retention, marketplace, korxona diagnostikasi | Boshlanmagan |

Sinxronlash uchun deterministik yozuv logi, Yjs va Automerge variantlari ochiq. Tanlashdan oldin yozuvlarning uzilishdan qayta ijrosi, parallel undo, biriktirma deduplikatsiyasi, hajm o‘sishi, key rotation va zarar yetkazuvchi konflikt variantlarini ikkita nusxada o‘lchang. Sxema yagonaligi bunda eng avvalgi talab.

Vektorli qidiruv keyingi jarayonda til sifati va qurilmaga qarab alohida o‘lchanadi. BM25, vektor va graf salmog‘i bir xil sinov savollarida baholanadi. Modellar yoki shaxsiy kontent tashqi xizmatga faqat egasining roziligi bilan yuboriladi.
