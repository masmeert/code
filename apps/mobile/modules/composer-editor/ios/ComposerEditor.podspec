Pod::Spec.new do |s|
  s.name           = 'ComposerEditor'
  s.version        = '1.0.0'
  s.summary        = 'Native attributed composer editor for MassCode.'
  s.description    = 'UIKit-backed rich text composer with atomic file mention and skill chips.'
  s.author         = 'MassCode'
  s.homepage       = 'https://github.com/apkiosk/masscode'
  s.platforms      = {
    :ios => '26.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
