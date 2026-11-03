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
- PC 서버로 시험하려면 `adb reverse tcp:3000 tcp:3000` + `SKIP_API_BASE=http://localhost:3000`. 평문 HTTP는 debug 빌드에서 `localhost`·`10.0.2.2`만 허용 (`android/app/src/debug/`)
- 앱 데이터(집·시간표·설정)는 브라우저와 따로 저장됨. 웹에서 쓰던 설정이 옮겨 오지 않음
- 실기기는 아직. 에뮬레이터(Android 37)에서만 확인

## 화면을 꺼도 이어지는 길안내 (안드로이드)
- `NavigationService.java`: 위치 유형 포그라운드 서비스. 길안내 단계 판정(웹과 같은 규칙: 목표 반경 안 → 다음, 지하·GPS 60초 끊김·목표 없음 → 예상 시각), 음성(TTS), 잠금화면 알림
  - 음성: 말할 때만 일시적 오디오 포커스(`GAIN_TRANSIENT_MAY_DUCK`, 용도 길안내)를 잡아 음악 소리를 줄였다가 끝나면 돌려줌. 볼륨을 직접 바꾸지 않음
  - 알림: 지금 단계·몇 단계째·남은 거리, 누르면 앱 열기, '길안내 종료' 버튼. 마지막 단계는 집 이름 대신 '목적지까지 걷기'
  - 시스템이 서비스를 다시 만들면 저장해 둔 단계부터 이어감
- 탈 버스 접근 알림: 정류장 60m 안(GPS가 없으면 정류장 도착 예정 2분 전부터)에서 `/api/bus`를 20초마다(5분 넘게 남으면 1분마다) 보고, '곧 도착'·'[1번째 전]'·90초 안이면 헤드업 알림(중요도 높음, 진동)+음성을 한 번 내고 그 버스는 그만 봄. 예정 출발 5분 뒤까지만, 타는 단계에서 정류장 400m 밖이면 이미 탄 것으로 봄. 서울시 키는 서버에만 (앱이 서울시 API를 직접 부르지 않음)
  - 웹(브라우저·아이폰 웹앱)도 같은 규칙(`checkArrival`)이지만 화면이 켜져 있고 페이지가 열려 있을 때만
- `SkipNavigationPlugin.java`: 웹 ↔ 서비스. `start/update/next/stop/speak/setMuted/getState`, 이벤트 `step/location/finished`
- 웹(`index.html`): 앱에선 웹 GPS·시각 판정을 끄고 서비스 이벤트로 화면을 맞춤. 화면이 켜져 있으면 지하철 시각 보정·갈아탈 버스 안내를 붙여 말하고(서비스는 8초 기다렸다 못 들으면 기본 문구), 바뀐 시각을 서비스로 넘김. 우회 제안·대안 경로는 그대로 웹에서

## iOS
- 시연은 웹앱(사파리 → 홈 화면에 추가)으로. 앱 빌드는 케이블·개발자 계정 문제로 보류

### iOS 앱 빌드 (보류, 무료 Apple ID + Sideloadly)
- `ios/`: `npx cap add ios`로 만든 프로젝트 (Swift Package Manager)
- `.github/workflows/ios-unsigned.yml`: GitHub의 macOS에서 서명 안 한 `SKIP-unsigned.ipa`를 만들어 Actions 결과물로 올림. 보류 중이라 수동 실행만 (`gh workflow run ios-unsigned.yml --ref feat/android-app`). 2026-11-01 빌드 성공
- PC의 Sideloadly가 무료 Apple ID로 서명해서 설치. 처음엔 USB 케이블로 아이폰 연결 필요, 7일마다 다시 설치

## 검증 기록
| 날짜 | 단계 | 결과 |
|---|---|---|
| 2026-11-01 | 1. 번들·Android 프로젝트 | `mobile:test` 6개 통과, `mobile/www` 24개 파일 29.2MB, `android/` 생성 |
| 2026-11-01 | 1. debug APK 빌드 | 성공 (JDK 21, `S:` 경로). `app-debug.apk` 21.2MB. 들어간 파일: 화면·vendor·OCR 모델만, `.env`·`api/`·`data/` 없음. 휴대폰 설치·실행은 아직 |
| 2026-11-01 | 1. 에뮬레이터 실행 | 아이폰 틀 없이 전체 화면, 상태바 안 겹침, 실시간 버스·지하철(배포 서버) 표시. 셔틀은 배포 서버에 API가 없어 오류(예상대로). 뒤로가기: 다른 탭→홈, 홈→앱 내림 (`@capacitor/app` 8.1.2) |
| 2026-11-01 | 3·4. 백그라운드 길안내 (에뮬레이터) | 시험 전용 좌표로 만든 4단계 경로. 앱을 홈으로 내리고 화면을 끈 상태에서 위치를 옮김 → 정류장 도착(GPS)·45초 뒤(지하 단계 예상 시각)·내릴 역 도착(GPS)마다 다음 단계, 알림 문구 갱신, 도착하면 서비스·알림 정리. 단계마다 오디오 포커스 요청→TTS 재생(3~4초)→반납 기록 확인. 앱을 다시 열면 웹 화면도 정리됨. 경로 검색 API는 안 부름 |
| 2026-11-03 | 탈 버스 접근 알림 (에뮬레이터) | 단위 테스트 5개(곧 도착·1번째 전·90초·먼 버스·운행종료) 통과. PC의 가짜 `/api/bus`(시험 전용 응답)로 앱을 홈으로 내리고 화면 끈 상태에서: 정류장 500m → 요청 0, 45m → 요청 시작, 6분 남음 → 다음 요청 65초 뒤, '[1번째 전]' → 헤드업 알림(채널 중요도 4) + 음성(오디오 포커스 요청·반납), 알림 뒤 45초 추가 요청 0. 서울시 API는 안 부름 |

### 아직 확인 못 한 것
- 실제 버스 정류장에서 접근 알림 (실제 '[1번째 전]' 문구·GPS 오차), 삼성 기기에서 헤드업 표시
- 웹의 접근 알림(`checkArrival`)을 실제 화면에서 돌려 보기 (문법 검사만)
- 실제 휴대폰에서 음악 앱을 틀어 둔 채 소리가 줄었다 돌아오는지 (에뮬레이터엔 음악 앱이 없음)
- 실제 버스·지하철 이동 (GPS 오차, 지하 구간)
- 최근 앱에서 지웠을 때·배터리 최적화가 강한 기종(삼성 등)에서 서비스 유지
