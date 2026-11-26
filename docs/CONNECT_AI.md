# AI’ni ulash

## Hozir sinash

Memory map’ni dasturchi rejimida oching. Manba nusxasida terminal buyrug‘i:

    sh start.command --ai-dev

Tayyor executable ham --ai-dev argumentini qabul qiladi. Ish maydonida **AI sozlamalari**ni oching. **AI’ni yoqish** katagini belgilang, **Mock**ni tanlang va **Sozlamalarni saqlash**ni bosing.

**Suhbat**ga o‘ting. Masalan, qayd ochiq turganida [mock:propose-edit] deb yozing. **So‘rovni ko‘rib chiqish** tugmasi aniq matnni va qaysi qaydlar kirganini ko‘rsatadi. **Tasdiqlash va yuborish**ni bosing. Taklif qizil va yashil bloklarda ko‘rinadi. **Takliflarni ko‘rish** bo‘limida tasdiqlangan o‘zgarishni bekor qilishingiz mumkin. **Tizim tuzish** rejimi lokal IELTS namunasini chiqaradi.

## Haqiqiy provayder bilan besh qadam

1. Provayderning rasmiy sahifasidan API kalitini oling.
2. **AI sozlamalari** oynasida provayder va modelni tanlang. Kalitni niqoblangan maydonga kiriting va saqlang.
3. Dasturchi ai/provider.py faylidagi adapterni provayderning rasmiy hujjatlari asosida to‘ldiradi. Ulanish tekshiruvini ham shu adapterga ulaydi.
4. **Ulanishni tekshirish** tugmasini bosing. Sinov qaydida oldindan ko‘rish, bekor qilish va limitlarni tekshiring.
5. Hammasi o‘tgach, haqiqiy provayderni tanlang va **AI’ni yoqish** katagini belgilang. Har so‘rovdan oldin **Nima yuboriladi?** oynasini ko‘rib chiqing.

Bu nusxada haqiqiy adapterlar ulanmagan. Kalitni saqlashning o‘zi tashqi so‘rov yubormaydi.
