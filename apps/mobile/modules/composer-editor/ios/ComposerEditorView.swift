import ExpoModulesCore
import UIKit

private struct ComposerTokenPayload: Decodable {
  let type: String
  let source: String
  let label: String
  let start: Int
  let end: Int
}

private struct ComposerSelectionPayload: Decodable {
  let start: Int
  let end: Int
}

private struct ComposerControlledDocumentPayload: Decodable {
  let value: String
  let selection: ComposerSelectionPayload?
  let tokensJson: String
  let mostRecentEventCount: Int
  let isNativeEcho: Bool
}

private struct ComposerThemePayload: Decodable {
  let text: String
  let placeholder: String
  let caret: String
  let chipBackground: String
  let chipBorder: String
  let skillBackground: String
  let skillBorder: String
  let skillText: String
  let fileTint: String
}

private struct ComposerChipStyle {
  let tint: UIColor
  let backgroundColor: UIColor
  let borderColor: UIColor
  let textColor: UIColor
}

private final class ComposerTextAttachment: NSTextAttachment {
  let source: String
  let label: String

  init(source: String, label: String, image: UIImage, size: CGSize, baselineOffset: CGFloat) {
    self.source = source
    self.label = label
    super.init(data: nil, ofType: nil)
    self.image = image
    bounds = CGRect(x: 0, y: baselineOffset, width: size.width, height: size.height)
  }

  required init?(coder: NSCoder) {
    nil
  }
}

private final class ComposerTextView: UITextView {
  private static let pastedImageDirectoryName = "composer-paste"
  private static let stalePastedImageAge: TimeInterval = 60 * 60
  private static let readOnlyActions = Set([
    "cut:",
    "delete:",
    "paste:",
    "redo:",
    "toggleBoldface:",
    "toggleItalics:",
    "toggleUnderline:",
    "undo:",
  ])

  var onPasteImages: (([String]) -> Void)?
  var onPasteText: ((String) -> Void)?
  var onAttributedMutation: (() -> Void)?
  var onSubmit: ((Bool) -> Void)?
  var isReadOnly = false
  var textPasteThresholdBytes = 0
  /// Shortcut HUD titles. JS supplies what the two sends actually do right now
  /// ("Queue Message" / "Steer Message"), so the iPad Command-hold list names
  /// the outcome rather than a generic "Send".
  var submitTitle = "Send Message"
  var alternateSubmitTitle = "Send Message"
  private var bypassTextPasteInterception = false

  override var keyCommands: [UIKeyCommand]? {
    var commands = super.keyCommands ?? []
    guard !isReadOnly, markedTextRange == nil else { return commands }
    // Return performs the configured follow-up and Command-Return its opposite.
    let submitOnReturn = UIKeyCommand(
      input: "\r",
      modifierFlags: [],
      action: #selector(submitMessage(_:))
    )
    submitOnReturn.discoverabilityTitle = submitTitle
    submitOnReturn.wantsPriorityOverSystemBehavior = true
    commands.append(submitOnReturn)

    let submitAlternate = UIKeyCommand(
      input: "\r",
      modifierFlags: .command,
      action: #selector(submitMessageAlternate(_:))
    )
    submitAlternate.discoverabilityTitle = alternateSubmitTitle
    submitAlternate.wantsPriorityOverSystemBehavior = true
    commands.append(submitAlternate)

    let newline = UIKeyCommand(
      input: "\r",
      modifierFlags: .shift,
      action: #selector(insertNewline(_:))
    )
    newline.discoverabilityTitle = "New Line"
    newline.wantsPriorityOverSystemBehavior = true
    commands.append(newline)

    if textPasteThresholdBytes > 0 {
      let pasteAsText = UIKeyCommand(
        input: "v",
        modifierFlags: [.command, .shift],
        action: #selector(pasteInline(_:))
      )
      pasteAsText.discoverabilityTitle = "Paste as Text"
      pasteAsText.wantsPriorityOverSystemBehavior = true
      commands.append(pasteAsText)
    }
    return commands
  }

  @objc private func submitMessage(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    onSubmit?(false)
  }

  @objc private func submitMessageAlternate(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    onSubmit?(true)
  }

  @objc private func insertNewline(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    insertText("\n")
  }

  @objc private func pasteInline(_ sender: UIKeyCommand) {
    guard !isReadOnly else {
      return
    }
    bypassTextPasteInterception = true
    defer { bypassTextPasteInterception = false }
    paste(sender)
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(submitMessage(_:)) || action == #selector(insertNewline(_:)) {
      return isEditable && !isReadOnly && markedTextRange == nil
    }
    if isReadOnly && Self.readOnlyActions.contains(NSStringFromSelector(action)) {
      return false
    }
    if action == #selector(paste(_:)) {
      let pasteboard = UIPasteboard.general
      if pasteboard.hasImages ||
        pasteboard.itemProviders.contains(where: {
          $0.canLoadObject(ofClass: UIImage.self)
        }) {
        return true
      }
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    guard !isReadOnly else {
      return
    }
    let pasteboard = UIPasteboard.general
    let imageProviders = pasteboard.itemProviders.filter {
      $0.canLoadObject(ofClass: UIImage.self)
    }
    if !imageProviders.isEmpty {
      loadImages(from: imageProviders)
      return
    }

    let images = pasteboard.images ?? []
    if !images.isEmpty {
      let urls = images.compactMap(Self.writeTemporaryImage)
      if !urls.isEmpty {
        onPasteImages?(urls)
        return
      }
    }
    if !bypassTextPasteInterception,
       let text = pasteboard.string, shouldInterceptTextPaste(text) {
      onPasteText?(text)
      return
    }
    super.paste(sender)
  }

  private func shouldInterceptTextPaste(_ text: String) -> Bool {
    guard textPasteThresholdBytes > 0, !text.isEmpty else { return false }
    return (text as NSString).length >= textPasteThresholdBytes ||
      text.utf8.count >= textPasteThresholdBytes
  }

  override func deleteBackward() {
    guard !isReadOnly else {
      return
    }
    guard selectedRange.length == 0, selectedRange.location > 0 else {
      super.deleteBackward()
      return
    }

    let previousOffset = selectedRange.location - 1
    if textStorage.attribute(.attachment, at: previousOffset, effectiveRange: nil)
      is ComposerTextAttachment {
      replaceDisplayRange(NSRange(location: previousOffset, length: 1))
      return
    }

    super.deleteBackward()
  }

  private func replaceDisplayRange(_ range: NSRange) {
    guard let start = position(from: beginningOfDocument, offset: range.location),
          let end = position(from: start, offset: range.length),
          let textRange = textRange(from: start, to: end) else {
      return
    }
    replace(textRange, withText: "")
  }

  func loadImages(from providers: [NSItemProvider]) {
    let group = DispatchGroup()
    let lock = NSLock()
    var images = [UIImage?](repeating: nil, count: providers.count)

    for (index, provider) in providers.enumerated() {
      group.enter()
      provider.loadObject(ofClass: UIImage.self) { object, _ in
        defer { group.leave() }
        guard let image = object as? UIImage else {
          return
        }
        lock.lock()
        images[index] = image
        lock.unlock()
      }
    }

    group.notify(queue: .main) { [weak self] in
      guard let self, !self.isReadOnly else {
        return
      }
      let urls = images.compactMap { $0 }.compactMap(Self.writeTemporaryImage)
      if !urls.isEmpty {
        self.onPasteImages?(urls)
      }
    }
  }

  // A chip copies as the text it stands for, so pasting it elsewhere keeps the mention.
  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else {
      return super.copy(sender)
    }
    UIPasteboard.general.string = serializedText(in: selectedRange)
  }

  override func cut(_ sender: Any?) {
    guard !isReadOnly else {
      return
    }
    guard isEditable, selectedRange.length > 0 else {
      return super.cut(sender)
    }
    copy(sender)
    textStorage.replaceCharacters(in: selectedRange, with: "")
    selectedRange = NSRange(location: selectedRange.location, length: 0)
    onAttributedMutation?()
  }

  func serializedText() -> String {
    serializedText(in: NSRange(location: 0, length: attributedText.length))
  }

  func serializedText(in range: NSRange) -> String {
    guard range.length > 0 else {
      return ""
    }

    let source = NSMutableString()
    let nsString = attributedText.string as NSString
    var cursor = range.location
    let end = NSMaxRange(range)
    attributedText.enumerateAttribute(.attachment, in: range) { value, attachmentRange, _ in
      if attachmentRange.location > cursor {
        source.append(
          nsString.substring(
            with: NSRange(location: cursor, length: attachmentRange.location - cursor)
          )
        )
      }
      if let attachment = value as? ComposerTextAttachment {
        source.append(attachment.source)
      } else {
        source.append(nsString.substring(with: attachmentRange))
      }
      cursor = NSMaxRange(attachmentRange)
    }
    if cursor < end {
      source.append(nsString.substring(with: NSRange(location: cursor, length: end - cursor)))
    }
    return source as String
  }

  func sourceOffset(forDisplayOffset displayOffset: Int) -> Int {
    let boundedOffset = max(0, min(attributedText.length, displayOffset))
    if boundedOffset == 0 {
      return 0
    }

    var sourceOffset = 0
    let range = NSRange(location: 0, length: boundedOffset)
    attributedText.enumerateAttribute(.attachment, in: range) { value, attributeRange, _ in
      if let attachment = value as? ComposerTextAttachment {
        sourceOffset += (attachment.source as NSString).length
      } else {
        sourceOffset += attributeRange.length
      }
    }
    return sourceOffset
  }

  private static func writeTemporaryImage(_ image: UIImage) -> String? {
    guard let data = image.pngData() else {
      return nil
    }
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(pastedImageDirectoryName, isDirectory: true)
    do {
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true
      )
      removeStaleTemporaryImages(in: directory)
      let url = directory.appendingPathComponent("\(UUID().uuidString).png")
      try data.write(to: url, options: .atomic)
      return url.absoluteString
    } catch {
      return nil
    }
  }

  private static func removeStaleTemporaryImages(in directory: URL) {
    let cutoff = Date().addingTimeInterval(-stalePastedImageAge)
    guard let urls = try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
      options: [.skipsHiddenFiles]
    ) else {
      return
    }

    for url in urls {
      guard
        let values = try? url.resourceValues(
          forKeys: [.contentModificationDateKey, .isRegularFileKey]
        ),
        values.isRegularFile == true,
        let modifiedAt = values.contentModificationDate,
        modifiedAt < cutoff
      else {
        continue
      }
      try? FileManager.default.removeItem(at: url)
    }
  }
}

public final class ComposerEditorView: ExpoView, UITextViewDelegate, UITextDropDelegate {
  private let textView = ComposerTextView()
  private let placeholderLabel = UILabel()
  private var value = ""
  private var tokensJson = "[]"
  private var tokens: [ComposerTokenPayload] = []
  private var requestedSelection: ComposerSelectionPayload?
  private var theme = ComposerThemePayload(
    text: "#262626",
    placeholder: "#8e8e93",
    caret: "#007aff",
    chipBackground: "#f2f2f7",
    chipBorder: "#dedee3",
    skillBackground: "#f9e8fb",
    skillBorder: "#e5a6eb",
    skillText: "#a21caf",
    fileTint: "#737373"
  )
  private var fontSize: CGFloat = 16
  private var lineHeight: CGFloat = 22
  private var isReadOnly = false
  private var isApplyingControlledValue = false
  private var nativeEventCount = 0
  private var lastContentSize = CGSize.zero
  private var tokensNeedRebuild = false
  private var chipsNeedMeasuredWidth = false

  let onComposerChange = EventDispatcher()
  let onComposerSelectionChange = EventDispatcher()
  let onComposerFocus = EventDispatcher()
  let onComposerBlur = EventDispatcher()
  let onComposerSubmit = EventDispatcher()
  let onComposerPasteImages = EventDispatcher()
  let onComposerPasteText = EventDispatcher()
  let onComposerContentSizeChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    clipsToBounds = false
    textView.delegate = self
    textView.textDropDelegate = self
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.keyboardDismissMode = .interactive
    textView.alwaysBounceVertical = false
    textView.showsVerticalScrollIndicator = true
    textView.adjustsFontForContentSizeCategory = true
    textView.onPasteImages = { [weak self] urls in
      self?.onComposerPasteImages(["uris": urls])
    }
    textView.onPasteText = { [weak self] text in
      guard let self else { return }
      let selection = self.sourceSelection()
      self.nativeEventCount += 1
      self.onComposerPasteText([
        "value": self.textView.serializedText(),
        "eventCount": self.nativeEventCount,
        "text": text,
        "selection": ["start": selection.start, "end": selection.end],
      ])
    }
    textView.onAttributedMutation = { [weak self] in
      self?.emitTextChange()
    }
    textView.onSubmit = { [weak self] alternate in
      self?.onComposerSubmit(["alternate": alternate])
    }
    addSubview(textView)

    placeholderLabel.numberOfLines = 0
    placeholderLabel.adjustsFontForContentSizeCategory = true
    addSubview(placeholderLabel)
    applyTypography()
    applyTheme()
  }

  public override var accessibilityElements: [Any]? {
    get {
      var elements: [Any] = [textView]
      let layout = textView.layoutManager
      textView.textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textView.textStorage.length)) { value, range, _ in
        guard let attachment = value as? ComposerTextAttachment else { return }
        let glyphRange = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layout.boundingRect(forGlyphRange: glyphRange, in: textView.textContainer)
          .offsetBy(dx: textView.textContainerInset.left, dy: textView.textContainerInset.top)
        guard rect.intersects(textView.bounds) else { return }
        let element = UIAccessibilityElement(accessibilityContainer: self)
        element.accessibilityLabel = attachment.label
        element.accessibilityTraits = .staticText
        element.accessibilityFrameInContainerSpace = textView.convert(rect, to: self)
        elements.append(element)
      }
      return elements
    }
    set { super.accessibilityElements = newValue }
  }

  public func textView(_ textView: UITextView, shouldInteractWith textAttachment: NSTextAttachment, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    // A chip is text context, not an image to save to the camera roll.
    !(textAttachment is ComposerTextAttachment)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    if chipsNeedMeasuredWidth, bounds.width > 0 {
      chipsNeedMeasuredWidth = false
      applyControlledDocument(force: true)
    }
    let placeholderX = textView.textContainerInset.left + textView.textContainer.lineFragmentPadding
    let placeholderY = textView.textContainerInset.top
    let placeholderWidth = max(
      0,
      bounds.width - placeholderX - textView.textContainerInset.right -
        textView.textContainer.lineFragmentPadding
    )
    placeholderLabel.frame = CGRect(
      x: placeholderX,
      y: placeholderY,
      width: placeholderWidth,
      height: max(lineHeight, placeholderLabel.font.lineHeight)
    )
    emitContentSizeIfNeeded()
  }

  func setControlledDocumentJson(_ documentJson: String) {
    guard let document = decode(ComposerControlledDocumentPayload.self, from: documentJson),
          document.mostRecentEventCount >= nativeEventCount else {
      return
    }
    if document.isNativeEcho && textView.serializedText() != document.value {
      return
    }
    if tokensJson != document.tokensJson {
      tokensJson = document.tokensJson
      tokens = decode([ComposerTokenPayload].self, from: document.tokensJson) ?? []
      tokensNeedRebuild = true
    }
    value = document.value
    requestedSelection = document.selection
    applyControlledDocument(force: tokensNeedRebuild)
    applyRequestedSelection()
    if tokensMatchCurrentValue() {
      tokensNeedRebuild = false
    }
  }

  func setThemeJson(_ themeJson: String) {
    guard let nextTheme = decode(ComposerThemePayload.self, from: themeJson) else {
      return
    }
    theme = nextTheme
    applyTheme()
    applyControlledDocument(force: true)
  }

  func setPlaceholder(_ placeholder: String) {
    placeholderLabel.text = placeholder
    setNeedsLayout()
  }

  func setFontSize(_ fontSize: CGFloat) {
    self.fontSize = fontSize
    applyTypography()
    applyControlledDocument(force: true)
  }

  func setLineHeight(_ lineHeight: CGFloat) {
    self.lineHeight = lineHeight
    applyTypography()
    applyControlledDocument(force: true)
  }

  func setContentInsetVertical(_ contentInsetVertical: CGFloat) {
    textView.textContainerInset = UIEdgeInsets(
      top: contentInsetVertical,
      left: 0,
      bottom: contentInsetVertical,
      right: 0
    )
    setNeedsLayout()
  }

  func setReadOnly(_ readOnly: Bool) {
    isReadOnly = readOnly
    textView.isReadOnly = readOnly
  }

  func setScrollEnabled(_ scrollEnabled: Bool) {
    textView.isScrollEnabled = scrollEnabled
  }

  func setSubmitTitle(_ title: String) {
    textView.submitTitle = title
  }

  func setAlternateSubmitTitle(_ title: String) {
    textView.alternateSubmitTitle = title
  }

  func setTextPasteThresholdBytes(_ threshold: Int) {
    textView.textPasteThresholdBytes = threshold
  }

  public func textViewDidChange(_ textView: UITextView) {
    emitTextChange()
  }

  public func textViewDidChangeSelection(_ textView: UITextView) {
    guard !isApplyingControlledValue else {
      return
    }
    restoreBaseTypingAttributes()
    // UIKit moves the selection before textViewDidChange runs. Emitting here
    // would pair the post-edit text with a pre-edit revision counter, so let
    // the change event that follows carry both; only pure caret moves emit.
    guard self.textView.serializedText() == value else {
      return
    }
    emitSelection()
  }

  public func textView(
    _ textView: UITextView,
    shouldChangeTextIn range: NSRange,
    replacementText text: String
  ) -> Bool {
    restoreBaseTypingAttributes()
    return !isReadOnly
  }

  public func textDroppableView(
    _ textDroppableView: UIView & UITextDroppable,
    proposalForDrop drop: UITextDropRequest
  ) -> UITextDropProposal {
    guard !isReadOnly else {
      return UITextDropProposal(operation: .cancel)
    }
    guard droppedImageProviders(in: drop) != nil else {
      return drop.suggestedProposal
    }

    // The composer owns image drops so UIKit does not insert NSTextAttachments
    // that the controlled plain-text value cannot represent.
    let proposal = UITextDropProposal(operation: .copy)
    proposal.dropAction = .insert
    proposal.dropPerformer = .delegate
    return proposal
  }

  public func textDroppableView(
    _ textDroppableView: UIView & UITextDroppable,
    willPerformDrop drop: UITextDropRequest
  ) {
    guard !isReadOnly else {
      return
    }
    guard let imageProviders = droppedImageProviders(in: drop) else {
      return
    }
    textView.loadImages(from: imageProviders)
  }

  private func droppedImageProviders(in drop: UITextDropRequest) -> [NSItemProvider]? {
    let providers = drop.dropSession.items.map(\.itemProvider)
    guard !providers.isEmpty,
          providers.allSatisfy({ $0.canLoadObject(ofClass: UIImage.self) }) else {
      return nil
    }
    return providers
  }

  public func textViewDidBeginEditing(_ textView: UITextView) {
    onComposerFocus()
  }

  public func textViewDidEndEditing(_ textView: UITextView) {
    onComposerBlur()
  }

  private func applyControlledDocument(force: Bool = false) {
    let currentSource = textView.serializedText()
    guard force || currentSource != value || !documentMatchesExpectedTokens() else {
      updatePlaceholderVisibility()
      return
    }

    let previousSelection = sourceSelection()
    isApplyingControlledValue = true
    textView.attributedText = makeAttributedDocument()
    let targetSelection = requestedSelection ?? previousSelection
    requestedSelection = nil
    textView.selectedRange = displayRange(for: targetSelection)
    restoreBaseTypingAttributes()
    isApplyingControlledValue = false
    updatePlaceholderVisibility()
    emitContentSizeIfNeeded()
  }

  private func makeAttributedDocument() -> NSAttributedString {
    let result = NSMutableAttributedString()
    let source = value as NSString
    var cursor = 0
    let validTokens = tokens.filter {
      $0.start >= cursor &&
        $0.end > $0.start &&
        $0.end <= source.length &&
        source.substring(with: NSRange(location: $0.start, length: $0.end - $0.start)) == $0.source
    }

    for token in validTokens {
      if token.start < cursor {
        continue
      }
      if token.start > cursor {
        appendPlainText(
          source.substring(with: NSRange(location: cursor, length: token.start - cursor)),
          to: result
        )
      }
      result.append(makeAttachmentString(token))
      cursor = token.end
    }
    if cursor < source.length {
      appendPlainText(
        source.substring(with: NSRange(location: cursor, length: source.length - cursor)),
        to: result
      )
    }
    return result
  }

  private func appendPlainText(_ text: String, to result: NSMutableAttributedString) {
    result.append(NSAttributedString(string: text, attributes: baseAttributes()))
  }

  private func makeAttachmentString(_ token: ComposerTokenPayload) -> NSAttributedString {
    let isSkill = token.type == "skill"
    let tint = UIColor(composerHex: isSkill ? theme.skillText : theme.fileTint) ?? .secondaryLabel
    let style = ComposerChipStyle(
      tint: tint,
      backgroundColor: UIColor(
        composerHex: isSkill ? theme.skillBackground : theme.chipBackground
      ) ?? .secondarySystemFill,
      borderColor: UIColor(
        composerHex: isSkill ? theme.skillBorder : theme.chipBorder
      ) ?? .separator,
      textColor: tint
    )
    let image = renderChip(
      label: token.label,
      iconName: isSkill ? "cube" : "doc",
      style: style
    )
    let font = UIFont.systemFont(ofSize: fontSize)
    let baselineOffset = floor((font.capHeight - image.size.height) / 2)
    let attachment = ComposerTextAttachment(
      source: token.source,
      label: token.label,
      image: image,
      size: image.size,
      baselineOffset: baselineOffset
    )
    let attributedAttachment = NSMutableAttributedString(attachment: attachment)
    attributedAttachment.addAttributes(
      baseAttributes(),
      range: NSRange(location: 0, length: attributedAttachment.length)
    )
    return attributedAttachment
  }

  private func renderChip(label: String, iconName: String, style: ComposerChipStyle) -> UIImage {
    let chipFontSize = fontSize * 0.86
    let font = UIFont.systemFont(ofSize: chipFontSize, weight: .medium)
    let icon = UIImage(
      systemName: iconName,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium)
    )
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .left
    let attributedLabel = NSMutableAttributedString(
      string: label,
      attributes: [.font: font, .foregroundColor: style.textColor, .paragraphStyle: paragraph]
    )
    let iconWidth: CGFloat = icon == nil ? 0 : chipFontSize * 1.17
    let iconGap: CGFloat = icon == nil ? 0 : chipFontSize * 0.33
    let padding = chipFontSize * 0.5
    let height = ceil(chipFontSize * 1.41)
    // A long path would otherwise draw a chip wider than the composer and clip. Cap the label
    // to the text the editor can actually show and truncate inside it, so the chip always fits
    // the line it sits on.
    let availableWidth = textView.textContainer.size.width > 0
      ? textView.textContainer.size.width - textView.textContainer.lineFragmentPadding * 2
      : (textView.window?.bounds.width ?? bounds.width)
    if availableWidth <= 0 {
      chipsNeedMeasuredWidth = true
    }
    let maximumLabelWidth = max(chipFontSize * 3, availableWidth - padding * 2 - iconWidth - iconGap)
    paragraph.lineBreakMode = .byTruncatingMiddle
    attributedLabel.addAttribute(
      .paragraphStyle,
      value: paragraph,
      range: NSRange(location: 0, length: attributedLabel.length)
    )
    let measured = attributedLabel.size()
    let textSize = CGSize(width: min(measured.width, maximumLabelWidth), height: measured.height)
    let width = ceil(padding * 2 + iconWidth + iconGap + textSize.width)
    let format = UIGraphicsImageRendererFormat.preferred()
    format.opaque = false
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
    return renderer.image { context in
      let rect = CGRect(origin: .zero, size: CGSize(width: width, height: height))
      let path = UIBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: chipFontSize * 0.5)
      style.backgroundColor.setFill()
      path.fill()
      style.borderColor.setStroke()
      path.lineWidth = 1
      path.stroke()

      var x = padding
      if let icon {
        icon.withTintColor(style.tint, renderingMode: .alwaysOriginal).draw(
          in: CGRect(x: x, y: (height - iconWidth) / 2, width: iconWidth, height: iconWidth)
        )
        x += iconWidth + iconGap
      }
      // Exactly the measured width: a spare pixel here would let a capped label draw past
      // the cap instead of truncating inside it.
      attributedLabel.draw(
        in: CGRect(x: x, y: (height - textSize.height) / 2, width: textSize.width, height: textSize.height)
      )
      context.cgContext.setAllowsAntialiasing(true)
    }
  }

  private func baseAttributes() -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    return [
      .font: UIFont.systemFont(ofSize: fontSize),
      .foregroundColor: UIColor(composerHex: theme.text) ?? .label,
      .paragraphStyle: paragraph,
    ]
  }

  private func applyTypography() {
    let font = UIFont.systemFont(ofSize: fontSize)
    textView.font = font
    restoreBaseTypingAttributes()
    placeholderLabel.font = font
    setNeedsLayout()
  }

  private func restoreBaseTypingAttributes() {
    guard textView.markedTextRange == nil else {
      return
    }
    textView.typingAttributes = baseAttributes()
  }

  private func applyTheme() {
    textView.textColor = UIColor(composerHex: theme.text) ?? .label
    placeholderLabel.textColor = UIColor(composerHex: theme.placeholder) ?? .placeholderText
    tintColor = UIColor(composerHex: theme.caret) ?? .systemBlue
  }

  private func emitTextChange() {
    guard !isApplyingControlledValue else {
      return
    }
    value = textView.serializedText()
    let selection = sourceSelection()
    nativeEventCount += 1
    onComposerChange([
      "value": value,
      "selection": ["start": selection.start, "end": selection.end],
      "eventCount": nativeEventCount,
    ])
    updatePlaceholderVisibility()
    emitContentSizeIfNeeded()
  }

  private func emitSelection() {
    // Caret moves advance the revision counter like text edits do: a
    // controlled payload computed before this move is stale and must fail the
    // revision guard instead of yanking the caret back mid-typing.
    let currentValue = textView.serializedText()
    let selection = sourceSelection()
    nativeEventCount += 1
    onComposerSelectionChange([
      "value": currentValue,
      "selection": ["start": selection.start, "end": selection.end],
      "eventCount": nativeEventCount,
    ])
  }

  private func sourceSelection() -> ComposerSelectionPayload {
    ComposerSelectionPayload(
      start: textView.sourceOffset(forDisplayOffset: textView.selectedRange.location),
      end: textView.sourceOffset(forDisplayOffset: NSMaxRange(textView.selectedRange))
    )
  }

  private func displayRange(for selection: ComposerSelectionPayload) -> NSRange {
    let start = displayOffset(forSourceOffset: selection.start)
    let end = displayOffset(forSourceOffset: selection.end)
    return NSRange(location: start, length: max(0, end - start))
  }

  private func displayOffset(forSourceOffset sourceOffset: Int) -> Int {
    let boundedOffset = max(0, min((value as NSString).length, sourceOffset))
    var collapsedLength = 0
    for token in tokens where token.end <= boundedOffset {
      collapsedLength += max(0, token.end - token.start - 1)
    }
    if let token = tokens.first(where: { $0.start < boundedOffset && boundedOffset < $0.end }) {
      return token.start - collapsedLength + 1
    }
    return boundedOffset - collapsedLength
  }

  private func applyRequestedSelection() {
    guard let requestedSelection else {
      return
    }
    let nextRange = displayRange(for: requestedSelection)
    guard nextRange.location <= textView.attributedText.length,
          NSMaxRange(nextRange) <= textView.attributedText.length else {
      return
    }
    self.requestedSelection = nil
    // Programmatically assigning selectedRange resets the keyboard's
    // autocorrect and predictive-text context even when the range is
    // unchanged, so a no-op assignment must be skipped.
    guard !NSEqualRanges(nextRange, textView.selectedRange) else {
      return
    }
    isApplyingControlledValue = true
    textView.selectedRange = nextRange
    isApplyingControlledValue = false
  }

  private func updatePlaceholderVisibility() {
    placeholderLabel.isHidden = !value.isEmpty
  }

  private func emitContentSizeIfNeeded() {
    let nextSize = textView.contentSize
    guard abs(nextSize.width - lastContentSize.width) > 0.5 ||
      abs(nextSize.height - lastContentSize.height) > 0.5 else {
      return
    }
    lastContentSize = nextSize
    onComposerContentSizeChange(["width": nextSize.width, "height": nextSize.height])
  }

  private func decode<T: Decodable>(_ type: T.Type, from json: String) -> T? {
    guard let data = json.data(using: .utf8) else {
      return nil
    }
    return try? JSONDecoder().decode(type, from: data)
  }

  private func tokensMatchCurrentValue() -> Bool {
    let source = value as NSString
    return tokens.allSatisfy {
      $0.start >= 0 &&
        $0.end > $0.start &&
        $0.end <= source.length &&
        source.substring(with: NSRange(location: $0.start, length: $0.end - $0.start)) == $0.source
    }
  }

  private func documentMatchesExpectedTokens() -> Bool {
    let source = value as NSString
    let expectedSources = tokens.compactMap { token -> String? in
      guard token.start >= 0,
            token.end > token.start,
            token.end <= source.length,
            source.substring(
              with: NSRange(location: token.start, length: token.end - token.start)
            ) == token.source else {
        return nil
      }
      return token.source
    }
    var renderedSources: [String] = []
    textView.attributedText.enumerateAttribute(
      .attachment,
      in: NSRange(location: 0, length: textView.attributedText.length)
    ) { value, _, _ in
      if let attachment = value as? ComposerTextAttachment {
        renderedSources.append(attachment.source)
      }
    }
    return renderedSources == expectedSources
  }
}

private extension UIColor {
  convenience init?(composerHex hex: String?) {
    guard var value = hex?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
      return nil
    }
    if value.hasPrefix("#") {
      value.removeFirst()
    }
    guard value.count == 6 || value.count == 8,
          let raw = UInt64(value, radix: 16) else {
      return nil
    }
    if value.count == 8 {
      self.init(
        red: CGFloat((raw >> 24) & 0xff) / 255,
        green: CGFloat((raw >> 16) & 0xff) / 255,
        blue: CGFloat((raw >> 8) & 0xff) / 255,
        alpha: CGFloat(raw & 0xff) / 255
      )
    } else {
      self.init(
        red: CGFloat((raw >> 16) & 0xff) / 255,
        green: CGFloat((raw >> 8) & 0xff) / 255,
        blue: CGFloat(raw & 0xff) / 255,
        alpha: 1
      )
    }
  }
}
