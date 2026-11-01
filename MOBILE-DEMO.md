# SKIP 안드로이드 시연 앱

시연용 debug APK. 스토어에 올리지 않는다. 진행 순서와 규칙은 `CLAUDE.md`의 '시연용 네이티브 앱 전환 하네스'.

## 구조
- `capacitor.config.json`: 앱 ID `app.skipcommute.demo`, 화면 파일 `mobile/www`, 네이티브 HTTP(CapacitorHttp) 켬
- `scripts/build-mobile.mjs`: 허용 목록(`index.html`, `manifest.webmanifest`, `icons/`, `vendor/`, `ocr/`, `models/ocr/`)만 `mobile/www`로 복사하고, `.env`·`api/`·`data/` 등이 들어가면 실패
- API 주소: `index.html`의 `<meta name="skip-api-base">` 한 곳. 웹은 빈 값(상대 경로), 앱 빌드가 `SKIP_API_BASE`(기본 `https://skip-commute.vercel.app`)로 채움
  - 앱에서는 `/api/`로 시작하는 요청만 그 주소로 보내고, OCR 모델·글꼴 등은 기기 안에서 읽음
  - 앱에서는 데모용 아이폰 틀, Vercel 통계, 서비스 워커, 웹 푸시를 끔
- `android/`: `npx cap add android`로 만든 프로젝트 (Gradle 8.14.3, compileSdk/targetSdk 36, minSdk 24)

## 명령
| 명령 | 하는 일 |
|---|---|
| `npm run mobile:build` | `mobile/www` 만들기 |
| `npm run mobile:test` | 번들 검사 (자산·비밀 파일·스크립트 문법·API 주소 바꾸기) |
| `npm run mobile:sync` | 번들 만들고 `android/`에 복사 |
| `npm run android:open` | Android Studio로 열기 |
| `npm run android:debug` | debug APK 빌드 → `android/app/build/outputs/apk/debug/app-debug.apk` |
| `npm run android:install` | 연결된 휴대폰에 설치 (adb) |

## 필요한 환경
- Android Studio (Android SDK, platform-tools 포함)
- Gradle은 JDK 21로 실행. PATH의 JDK 25와 Android Studio에 들어 있는 jbr(25)은 Gradle 8.14가 지원하지 않음
  - 이 PC: `$env:JAVA_HOME = "$env:LOCALAPPDATA\Programs\jdk-21"` (Microsoft OpenJDK 21)
- 프로젝트 경로에 한글이 있으면 안드로이드 빌드가 멈춤 → 한글 없는 드라이브로 연결해서 빌드
  - `subst S: "C:\Users\ldm10\orca\projects\동아리 해커톤-android"` → PowerShell에서 `& S:\android\gradlew.bat assembleDebug`
  - `subst`는 재부팅하면 풀림
- 휴대폰: 개발자 옵션 → USB 디버깅 켜기, PC와 USB 연결

## 알려진 제한
- 배포 서버(`main`)에는 아직 `/api/reports`, `/api/shuttle`이 없어서, 앱에서 제보·셔틀은 `main`에 반영되기 전까지 실패함
  - PC 서버로 시험하려면 `adb reverse tcp:3000 tcp:3000` + `SKIP_API_BASE=http://localhost:3000`. 단 안드로이드 평문 HTTP 허용(디버그 전용 설정)이 아직 없음
- 앱 데이터(집·시간표·설정)는 브라우저와 따로 저장됨. 웹에서 쓰던 설정이 옮겨 오지 않음
- 실기기는 아직. 에뮬레이터(Android 37)에서만 확인

## iOS (무료 Apple ID + Sideloadly)
- `ios/`: `npx cap add ios`로 만든 프로젝트 (Swift Package Manager)
- `.github/workflows/ios-unsigned.yml`: GitHub의 macOS에서 서명 안 한 `SKIP-unsigned.ipa`를 만들어 Actions 결과물로 올림 (브랜치에 푸시해야 실행됨)
- PC의 Sideloadly가 무료 Apple ID로 서명해서 설치. 처음엔 USB 케이블로 아이폰 연결 필요, 7일마다 다시 설치

## 검증 기록
| 날짜 | 단계 | 결과 |
|---|---|---|
| 2026-11-01 | 1. 번들·Android 프로젝트 | `mobile:test` 6개 통과, `mobile/www` 24개 파일 29.2MB, `android/` 생성 |
| 2026-11-01 | 1. debug APK 빌드 | 성공 (JDK 21, `S:` 경로). `app-debug.apk` 21.2MB. 들어간 파일: 화면·vendor·OCR 모델만, `.env`·`api/`·`data/` 없음. 휴대폰 설치·실행은 아직 |
| 2026-11-01 | 1. 에뮬레이터 실행 | 아이폰 틀 없이 전체 화면, 상태바 안 겹침, 실시간 버스·지하철(배포 서버) 표시. 셔틀은 배포 서버에 API가 없어 오류(예상대로). 뒤로가기: 다른 탭→홈, 홈→앱 내림 (`@capacitor/app` 8.1.2) |
