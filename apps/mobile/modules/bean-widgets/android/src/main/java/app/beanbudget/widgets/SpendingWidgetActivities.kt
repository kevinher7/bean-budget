package app.beanbudget.widgets

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import java.time.LocalDate
import java.time.ZoneId

// The Expo development launcher can replace the initial URL while starting the JS bundle.
internal val pendingBudgetShortcut = java.util.concurrent.atomic.AtomicReference<String?>()

class SpendingShortcutActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    pendingBudgetShortcut.set(intent.dataString?.substringAfter("://"))
    startActivity(BeanWidgets.appIntent(this, "widget"))
    finish()
  }
}

class SpendingWidgetConfiguration : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    setResult(RESULT_CANCELED)
    val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    val provider = AppWidgetManager.getInstance(this).getAppWidgetInfo(id)?.provider
    if (provider?.packageName != packageName || spendingLayouts.keys.none { it.name == provider.className }) {
      finish()
      return
    }
    widgetUpdates.execute {
      val choices = runCatching { spendingToday(this, LocalDate.now(ZoneId.of("Asia/Tokyo"))) }.getOrDefault(emptyList())
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        val dialog = AlertDialog.Builder(this).setTitle("Choose a category")
          .setNegativeButton("Cancel") { _, _ -> finish() }.setOnCancelListener { finish() }
        if (choices.isEmpty()) {
          dialog.setMessage("Open Bean Budget to refresh your weekly and daily category plans.")
            .setPositiveButton("Open budget") { _, _ ->
              BeanWidgets.openApp(this, "budget").send()
              finish()
            }
        } else {
          val labels = choices.map { "${it.budgetName} · ${it.name}" }.toTypedArray()
          dialog.setItems(labels) { _, index ->
            val row = choices[index]
            getSharedPreferences(widgetPreferences, MODE_PRIVATE).edit()
              .putString("budget/$id", row.budget).putString("category/$id", row.category)
              .putString("server/$id", row.server).apply()
            widgetUpdates.execute { BeanWidgets.refresh(applicationContext) }
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
            finish()
          }
        }
        dialog.show()
      }
    }
  }
}
