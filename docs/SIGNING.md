# «Noma'lum dasturchi» o‘rniga «Nurmuhammad» (kod imzolash)

Windows va macOS ogohlantirishida ko‘rinadigan nom **faqat imzolangan** dasturda chiqadi va u sertifikatdagi nom bo‘ladi. Buni kod bilan «o‘rnatib» bo‘lmaydi: kerakli sertifikatlarni siz xarid qilasiz, workflow esa ularni ishlatadi.

## Qilingan ish
- Windows dasturining xossalarida Company = `Nurmuhammad`, Product = `Memory map` (`xotira.spec`). Bu faqat fayl xossasi; SmartScreen ogohlantirishini o‘zi yo‘qotmaydi.
- `.github/workflows/build.yml` da imzolash qadamlari bor. Ular GitHub Secrets to‘ldirilgandagina ishlaydi, aks holda o‘tkazib yuboriladi.
- Bu qadamlarni men ishga tushirib ko‘rmadim (sertifikat va Windows/macOS runner kerak). Birinchi urinishda xato chiqsa, logni yuboring.

## Nima sotib olinadi
**macOS:** Apple Developer Program (yiliga $99). Ichidan «Developer ID Application» sertifikati. Ko‘rinadigan nom shaxsiy hisobda sizning to‘liq ismingiz (masalan «Nurmuhammad Familiya»), kompaniya hisobida kompaniya nomi bo‘ladi. «Nurmuhammad» deyarli alohida chiqmaydi, chunki Apple haqiqiy ismni talab qiladi.

**Windows:** kod imzolash sertifikati (OV yoki EV, taxminan yiliga $100–400) yoki Microsoft «Trusted Signing» (arzonroq, lekin faqat ayrim mamlakat va tashkilotlar uchun; sizning holatingizda mavjudligini tekshirishingiz kerak). Eslatma: yangi OV sertifikat bilan SmartScreen ogohlantirishi dastlab baribir chiqishi mumkin, EV sertifikatda darhol yo‘qoladi.

## GitHub Secrets (Settings → Secrets and variables → Actions)
| Secret | Nima |
|---|---|
| `WINDOWS_CERT_BASE64`, `WINDOWS_CERT_PASSWORD` | `.pfx` faylning base64 matni va paroli |
| `APPLE_CERT_BASE64`, `APPLE_CERT_PASSWORD` | `.p12` (Developer ID) base64 va paroli |
| `APPLE_SIGN_IDENTITY` | masalan `Developer ID Application: Ism Familiya (TEAMID)` |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | notarizatsiya uchun (app-specific parol) |

## Cheklov
macOS uchun hozir bitta bajariladigan fayl (`.tar.gz`) qurilmoqda; «ikki marta bosish» qulayligi uchun to‘liq `.app` paketi kerak va uni Mac'da sinash zarur. Bu keyingi qadam.
