plugins {
  alias(libs.plugins.android.application)
}

android {
    namespace = "com.example.taiwanneighborhoodmonitor"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.example.taiwanneighborhoodmonitor"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
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

dependencies {
  // 核心 AndroidX 與協程依賴 (無冗餘 Compose UI，極致輕量化)
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose) // 提供 ComponentActivity 支援
  implementation(libs.okhttp) // 現代高效連線池、HTTP/2 多路複用與 Transparent Gzip

  // 單元測試
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
}
