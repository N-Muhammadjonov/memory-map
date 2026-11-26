# Ma’lumot modeli

| Jadval yoki obyekt | Tayinlanishi | Saqlanishi |
|---|---|---|
| `notes` | Barqaror UUID, talqin, sarlavha, matn, teg, alias, manba, yo‘l va savat holati | Sarlavha va matn kabi yuk AES-GCM bilan |
| `entity_fields` | `type`, `status`, `priority`, `due`, `icon`, `cover`, `relationships` | Qayd IDsi, mustaqil talqin va shifrlangan JSON |
| `note_history` | Avvalgi qayd yuklari va savat holati | Faol talqin yangilanganda avvalgi shifrlangan yozuv ayni tranzaksiyada yoziladi |
| `entity_history` | Avvalgi xususiyat va aloqalar | Saqlangan xususiyat talqini uchun AES-GCM |
| `legacy_entity_fields` | Har qaydda bir marta ko‘rib chiqilgan eski maydonlar | Qayd IDsi va shifrlangan maydonlar ro‘yxati |
| `attachments`, `drawings` | Asl fayl, nom, chizma chiziqlari va asosiy rasm | V13 kontekstli shifrlash |
| `metadata` | Salt, ombor IDsi, tasdiq, sevimlilar va koordinatalar | Sevimlilar va koordinatalar shifrlangan |
| Qidiruv indeksi | So‘z chastotasi va grafik qo‘shniligi | Qulf ochiq seansdagi RAM |

Mahalliy obyektlar mavjud qayd identifikatoridan foydalanadi. Standart tur `note`. `task`, `project`, `paper` kabi turlar shu modelga tegishli. Bog‘lanish `type` va nishon qayd IDsi bilan saqlanadi. Savatdagi yoki o‘chirilgan nishon xarita va qidiruvda ko‘rsatilmaydi. Doimiy o‘chirish qaydning tarixini ham o‘chiradi. Qayddagi Markdown havolalari alohida matn sintaksisidir.

Talqinlar eski qiymatlarni qayta tiklash imkonini beradi. Xususiyat va matn talqinlari alohida yuradi. Biriktirma yoki PDF binar kontentining har tahriri uchun tarix mavjud emas. Eksportdagi `entities.json` faol obyektlar va bog‘lanishlarni, ichki `.xotira` esa to‘liq saqlangan omborni ifodalaydi.
