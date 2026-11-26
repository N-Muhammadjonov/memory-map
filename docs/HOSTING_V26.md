# Ommaviy sahifa uchun hosting (v26)

Memory map ichidagi havola (`http://127.0.0.1:…/p/…`) faqat sizning kompyuteringizda va ilova ochiq paytda ishlaydi. Boshqa odamlar ocha olishi uchun tanlangan bitta sahifa sizning serveringizga yuklanadi.

## Nima yuboriladi va nima yuborilmaydi

- Yuboriladi: faqat tanlangan qaydning tayyor HTML sahifasi (sarlavha, teglar, matn, 2 MB gacha rasmlar).
- Yuborilmaydi: ombor, parol, boshqa qaydlar, biriktirmalar. Boshqa qaydlarga havolalar oddiy matnga aylantiriladi.
- Parol qulfi qo‘ysangiz (10+ belgi), sahifa brauzerda AES-256-GCM bilan shifrlanadi. Shifrlangan matn ommaviy bo‘lgani uchun uni oflayn taxmin qilish mumkin, shuning uchun uzun parol tanlang.

## Serverni ishga tushirish

Bu tekshirilgan qism: `python3 publish_server.py --data ./pages --key "<16+ belgili sir>" --base-url https://pages.example.com`

Server Python standart kutubxonasida ishlaydi, qo‘shimcha paket kerak emas. `127.0.0.1:8787` da tinglaydi. Ochiq internetga HTTPS orqali chiqarish uchun uning oldiga reverse proxy qo‘ying. Caddy misoli (shu yerda sinab ko‘rilmagan):

```
pages.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## Xotirada ulash

Qaydda **Share** → **Publish this note** → **Save sharing**. Keyin **Link for everyone** bo‘limida server manzili va kalitni kiriting, **Publish to host** ni bosing. Manzil serverdan keladi: `https://pages.example.com/p/<tasodifiy 22 belgi>`.

Server manzili va kalit ombor ichida shifrlangan holda saqlanadi.

## Xavfsizlik xususiyatlari (testlangan)

- Kalitsiz yuklash, o‘chirish va yangilash 401 qaytaradi.
- Qayd Trash'ga tushsa yoki butunlay o‘chirilsa, serverdagi nusxa o‘chadi. Server javob bermasa, o‘chirish navbatda qoladi va keyingi urinishda takrorlanadi.
- Parolsiz sahifa `script-src 'none'` siyosati bilan beriladi. Qulfli sahifa faqat o‘zining ichki deshifrlash skripti uchun ruxsat oladi.
- `http://` faqat localhost uchun qabul qilinadi; boshqa manzillar `https://` bo‘lishi kerak.

## Cheklovlar

- Bitta server kaliti bitta egasiga mo‘ljallangan; ko‘p foydalanuvchili hosting emas.
- Sahifa qaydning o‘sha paytdagi nusxasi. Qayd o‘zgarsa, **Update hosted page** ni bosing.
- Qulfsiz ochiq havolani biladigan har kim sahifani ko‘radi va uzata oladi.
- Server tomonda foydalanish statistikasi yo‘q.
