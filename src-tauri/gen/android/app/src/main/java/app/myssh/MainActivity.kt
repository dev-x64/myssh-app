package app.myssh

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  /** The system bars' insets, in CSS pixels, as the window last told them. */
  private var insets = Insets(0f, 0f, 0f, 0f)

  private data class Insets(val top: Float, val right: Float, val bottom: Float, val left: Float)

  /** What the session service's notification says now; `null` while it is stopped. */
  private var sessionText: String? = null

  // The window answers Back itself: a sheet closes, a terminal goes back to
  // the hosts. Leaving the app only puts it behind, so that sessions go on.
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // The page is drawn under the status and navigation bars, and is told
    // how much of it they cover. The keyboard instead makes the page shorter,
    // so that the terminal's last line stays above it.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(0, 0, 0, ime.bottom)
      val density = resources.displayMetrics.density
      insets = Insets(
        bars.top / density,
        bars.right / density,
        // Over the keyboard there is no navigation bar to keep clear of.
        if (ime.bottom > 0) 0f else bars.bottom / density,
        bars.left / density,
      )
      pushInsets()
      WindowInsetsCompat.CONSUMED
    }

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = webView
        if (view == null) {
          moveTaskToBack(true)
          return
        }
        view.evaluateJavascript("Boolean(window.__mysshBack && window.__mysshBack())") { handled ->
          if (handled != "true") moveTaskToBack(true)
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    followPage()
    // The page is not loaded yet: told now, it would forget. Told again a
    // few times as it starts, and every time the bars change after that.
    for (delay in longArrayOf(0, 300, 1000, 2500)) webView.postDelayed({ pushInsets() }, delay)
  }

  override fun onResume() {
    super.onResume()
    pushInsets()
  }

  /**
   * Follows what the page shows, asked now and then, as it can change at any
   * time: the theme, for the bars' icons (dark over the light theme, light
   * over the dark one), and the open sessions, for the service that keeps
   * them connected while the app is in the background.
   */
  private fun followPage() {
    val view = webView ?: return
    view.evaluateJavascript("window.__mysshState ? window.__mysshState() : ''") { answer ->
      val state = try {
        // The answer is the JSON of a string of JSON.
        JSONObject(JSONObject("{\"s\":$answer}").getString("s"))
      } catch (e: Exception) {
        null
      }
      if (state != null) {
        val light = state.optString("theme") == "light"
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (controller.isAppearanceLightStatusBars != light) {
          controller.isAppearanceLightStatusBars = light
          controller.isAppearanceLightNavigationBars = light
        }
        followSessions(state)
      }
    }
    view.postDelayed({ followPage() }, 1000)
  }

  private fun followSessions(state: JSONObject) {
    val count = state.optInt("sessions")
    if (count == 0) {
      if (sessionText != null) stopService(Intent(this, SessionService::class.java))
      sessionText = null
      return
    }
    val text = state.optString("text")
    if (text == sessionText) return
    val intent = Intent(this, SessionService::class.java)
      .putExtra(SessionService.EXTRA_TITLE, state.optString("title"))
      .putExtra(SessionService.EXTRA_TEXT, text)
      .putExtra(SessionService.EXTRA_CHANNEL, state.optString("channel"))
    try {
      // Started while the app is in sight; told of a change once it runs.
      if (sessionText == null) ContextCompat.startForegroundService(this, intent) else startService(intent)
      if (sessionText == null) askForNotifications()
      sessionText = text
    } catch (e: Exception) {
      // Not allowed now (the app is behind); tried again on the next look.
    }
  }

  /** Once: may the notification of open sessions be shown (Android 13 asks). */
  private fun askForNotifications() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    val prefs = getSharedPreferences("myssh", MODE_PRIVATE)
    if (prefs.getBoolean("notifications_asked", false)) return
    prefs.edit().putBoolean("notifications_asked", true).apply()
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { granted ->
      // Posted before it was allowed, the notification was not shown: posted again.
      if (granted == true && sessionText != null) sessionText = ""
    }
  }

  private fun pushInsets() {
    val (top, right, bottom, left) = insets
    webView?.evaluateJavascript(
      """(function(){var s=document.documentElement.style;""" +
        """s.setProperty('--inset-top','${top}px');s.setProperty('--inset-right','${right}px');""" +
        """s.setProperty('--inset-bottom','${bottom}px');s.setProperty('--inset-left','${left}px');})()""",
      null,
    )
  }
}
