import AppKit
import Vision
import Foundation

var rows: [[String: String]] = []
for path in CommandLine.arguments.dropFirst() {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.015
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        if !text.isEmpty { rows.append(["frame": path, "text": text]) }
    } catch { continue }
}
let data = try! JSONSerialization.data(withJSONObject: rows)
print(String(data: data, encoding: .utf8)!)
