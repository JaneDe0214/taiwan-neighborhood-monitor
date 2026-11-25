plugins {
  alias(libs.plugins.android.application)
}

android {
    namespace = "com.example.taiwanneighborhoodmonitor"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.example.taiwanneighborhoodmonitor"
        minSdk = 24
        targetSdk = 36
        versionCode = 2
        versionName = "2.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
      compose = false
      aidl = false
      buildConfig = false
      shaders = false
    }

    packaging {
      resources {
        excludes += "/META-INF/{AL2.0,LGPL2.1}"
      }
    }
}

kotlin {
    jvmToolchain(17)
}

// 建置前自動將根目錄最新前端檔案與即時快照資料集同步至 Android assets，徹底消除雙端版本落差
val repoRootDir = rootProject.projectDir.parentFile
val syncWebAssets = tasks.register<Copy>("syncWebAssets") {
    from(repoRootDir) {
        include("index.html", "manifest.json", "dpuLogo.jpg", "dpuLogo_icon.png", "favicon.png")
    }
    from(File(repoRootDir, "data")) {
        into("data")
    }
    into(layout.projectDirectory.dir("src/main/assets"))
}

tasks.named("preBuild") {
    dependsOn(syncWebAssets)
}

tasks.matching { it.name != "syncWebAssets" && it.name.endsWith("Assets") }.configureEach {
    dependsOn(syncWebAssets)
}

dependencies {
  // 核心 AndroidX 與協程依賴 (移除未使用之 Compose UI 套件，改用純粹 activity-ktx 極致輕量化)
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.ktx)
  implementation(libs.okhttp) // 現代高效連線池、HTTP/2 多路複用與 Transparent Gzip

  // 單元測試
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.org.json)
}
