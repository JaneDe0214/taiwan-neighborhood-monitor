# 保留 WebView @JavascriptInterface 原生橋接方法以免混淆或 R8 移除
-keepclassmembers class com.example.taiwanneighborhoodmonitor.AndroidNativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-keep class com.example.taiwanneighborhoodmonitor.AndroidNativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
