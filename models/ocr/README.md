# OCR 모델

시간표 사진 인식(`ocr/`)에 쓰는 PaddleOCR 모델의 ONNX 변환본. 브라우저에서 실행되며 사진은 외부로 보내지 않는다.

| 파일 | 모델 | 출처 |
|---|---|---|
| `det.onnx` | PP-OCRv3 mobile 글자 위치 검출 | [monkt/paddleocr-onnx](https://huggingface.co/monkt/paddleocr-onnx) `detection/v3` |
| `rec.onnx`, `dict.txt` | PP-OCRv5 한국어 인식 (korean_PP-OCRv5_mobile_rec) | 같은 저장소 `languages/korean` |

원본: [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), Apache License 2.0.
