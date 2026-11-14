package app.beanbudget.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import java.io.File
import java.math.BigDecimal
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.Executors

private val widgetUpdates = Executors.newSingleThreadExecutor()

private data class CurrencyBalance(val currency: String, val posted: Long, val projected: Long)

private data class RegisterSummary(
  val balances: List<CurrencyBalance>,
  val waiting: Int,
  val failed: Int,
  val updatedAt: String?,
  val lastSyncedAt: String?
)

object BeanWidgets {
  @Synchronized
  fun refresh(context: Context) {
    val manager = AppWidgetManager.getInstance(context)
    val registerIds = manager.getAppWidgetIds(ComponentName(context, RegisterWidgetProvider::class.java))
    if (registerIds.isNotEmpty()) {
      val result = runCatching { readSummary(context) }
      for (id in registerIds) manager.updateAppWidget(id, registerViews(context, result))
    }
    for (id in manager.getAppWidgetIds(ComponentName(context, AddWidgetProvider::class.java))) {
      val views = RemoteViews(context.packageName, R.layout.bean_add_widget)
      views.setOnClickPendingIntent(R.id.bean_widget_root, openApp(context, "entry"))
      manager.updateAppWidget(id, views)
    }
  }

  private fun readSummary(context: Context): RegisterSummary {
    val file = File(context.filesDir, "SQLite/bean-budget.sqlite")
    if (!file.isFile) return RegisterSummary(emptyList(), 0, 0, null, null)
    SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { database ->
      require(database.version in 3..4) { "Open the app to update local storage" }
      val balances = mutableListOf<CurrencyBalance>()
      var waiting = 0
      var failed = 0
      var updatedAt: String? = null
      var lastSyncedAt: String? = null
      // One small result set keeps balances, queue state and freshness in the same SQLite snapshot.
      database.rawQuery(
        """
        WITH account_records AS (
          SELECT id, json_extract(payload, '$.currency') AS currency
          FROM records WHERE kind='accounts'
        ), balance_rows AS (
          SELECT a.currency,
            COALESCE(SUM(CASE WHEN json_extract(t.payload, '$.status')='pending' THEN 0
              ELSE json_extract(t.payload, '$.amount') END), 0) AS posted,
            COALESCE(SUM(json_extract(t.payload, '$.amount')), 0) AS projected
          FROM account_records a LEFT JOIN records t
            ON t.kind='transactions' AND json_extract(t.payload, '$.accountId')=a.id
          GROUP BY a.currency
        )
        SELECT currency, posted, projected, NULL, NULL, 0 FROM balance_rows
        UNION ALL
        SELECT NULL, (SELECT COUNT(*) FROM outbox),
          (SELECT COUNT(*) FROM outbox WHERE error IS NOT NULL),
          (SELECT value FROM metadata WHERE name='widgetUpdatedAt'),
          (SELECT value FROM metadata WHERE name='lastSyncedAt'),
          (SELECT COUNT(*) FROM records t WHERE kind='transactions' AND (
            COALESCE(json_type(payload, '$.amount'), '') != 'integer'
            OR ABS(json_extract(payload, '$.amount')) > 1000000000000
            OR COALESCE(json_type(payload, '$.id'), '') != 'text'
            OR COALESCE(json_extract(payload, '$.id'), '') != id
            OR COALESCE(json_type(payload, '$.accountId'), '') != 'text'
            OR COALESCE(json_extract(payload, '$.kind'), '') NOT IN ('opening', 'transaction')
            OR (json_type(payload, '$.status') IS NOT NULL AND (
              json_type(payload, '$.status') != 'text'
              OR json_extract(payload, '$.status') NOT IN ('pending', 'posted')
            ))
            OR NOT EXISTS (SELECT 1 FROM account_records a WHERE a.id=json_extract(t.payload, '$.accountId'))
          )) + (SELECT COUNT(*) FROM records WHERE kind='accounts' AND (
            COALESCE(json_type(payload, '$.id'), '') != 'text'
            OR COALESCE(json_extract(payload, '$.id'), '') != id
            OR COALESCE(json_type(payload, '$.currency'), '') != 'text'
            OR COALESCE(json_extract(payload, '$.currency'), '') NOT IN ('JPY', 'USD')
          ))
        """.trimIndent(), null
      ).use { cursor ->
        while (cursor.moveToNext()) {
          if (cursor.isNull(0)) {
            require(cursor.getInt(5) == 0) { "Invalid local transaction" }
            waiting = cursor.getInt(1)
            failed = cursor.getInt(2)
            updatedAt = cursor.getString(3)
            lastSyncedAt = cursor.getString(4)
          } else {
            val currency = cursor.getString(0)
            require(currency == "JPY" || currency == "USD") { "Unsupported currency" }
            balances.add(CurrencyBalance(currency, cursor.getLong(1), cursor.getLong(2)))
          }
        }
      }
      updatedAt?.let { Instant.parse(it) }
      lastSyncedAt?.let { Instant.parse(it) }
      return RegisterSummary(balances, waiting, failed, updatedAt, lastSyncedAt)
    }
  }

  private fun registerViews(
    context: Context,
    result: Result<RegisterSummary>
  ): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.bean_register_widget)
    views.setOnClickPendingIntent(R.id.bean_widget_root, openApp(context, "register"))
    val summary = result.getOrNull()
    if (summary == null || summary.balances.isEmpty()) {
      views.setTextViewText(R.id.bean_widget_empty,
        if (summary == null) "Local data unavailable\nOpen Bean Budget to retry"
        else "Open Bean Budget\nto add an account")
      return views
    }
    views.setViewVisibility(R.id.bean_widget_empty, View.GONE)
    views.setViewVisibility(R.id.bean_widget_balances, View.VISIBLE)
    setCurrencyViews(context, views, summary, "JPY", R.id.bean_widget_jpy, R.id.bean_widget_jpy_posted, R.id.bean_widget_jpy_projected)
    setCurrencyViews(context, views, summary, "USD", R.id.bean_widget_usd, R.id.bean_widget_usd_posted, R.id.bean_widget_usd_projected)
    val waiting = "${summary.waiting} waiting " + if (summary.waiting == 1) "operation" else "operations"
    views.setTextViewText(R.id.bean_widget_sync, when {
      summary.failed > 0 -> "${summary.failed} failed · $waiting"
      summary.waiting > 0 -> waiting
      summary.lastSyncedAt == null -> "Local only · not synchronized"
      else -> "Synced ${timestamp(summary.lastSyncedAt)}"
    })
    views.setTextColor(R.id.bean_widget_sync, color(context, if (summary.failed > 0) "error" else "secondary"))
    views.setTextViewText(R.id.bean_widget_freshness,
      summary.updatedAt?.let { "Local ${timestamp(it)}" } ?: "Local update time unavailable")
    views.setContentDescription(R.id.bean_widget_root,
      "Bean Budget. Local balances across all accounts, separated by currency. Tap to open the register.")
    return views
  }

  private fun setCurrencyViews(
    context: Context,
    views: RemoteViews,
    summary: RegisterSummary,
    currency: String,
    container: Int,
    posted: Int,
    projected: Int
  ) {
    val balance = summary.balances.find { it.currency == currency }
    views.setViewVisibility(container, if (balance == null) View.GONE else View.VISIBLE)
    if (balance == null) return
    val postedText = "${money(balance.posted, balance.currency)} posted"
    val projectedText = "${money(balance.projected, balance.currency)} projected"
    views.setTextViewText(posted, postedText)
    views.setTextViewText(projected, projectedText)
    views.setTextColor(posted, color(context, if (balance.posted < 0) "error" else "text"))
    views.setContentDescription(posted, "${balance.currency} $postedText across all accounts")
    views.setContentDescription(projected, "${balance.currency} $projectedText including bank-pending entries")
  }

  private fun money(units: Long, currency: String): String {
    val amount = BigDecimal.valueOf(units, if (currency == "USD") 2 else 0)
    val formatter = NumberFormat.getNumberInstance(Locale.US)
    formatter.minimumFractionDigits = if (currency == "USD") 2 else 0
    formatter.maximumFractionDigits = formatter.minimumFractionDigits
    return (if (currency == "JPY") "¥" else "US$") + formatter.format(amount)
  }

  private fun timestamp(value: String): String = DateTimeFormatter.ofPattern("MM-dd HH:mm 'JST'", Locale.US)
    .withZone(ZoneId.of("Asia/Tokyo"))
    .format(Instant.parse(value))

  private fun color(context: Context, name: String): Int = context.getColor(
    context.resources.getIdentifier("bean_widget_$name", "color", context.packageName)
  )

  private fun openApp(context: Context, destination: String): PendingIntent {
    val scheme = when (context.packageName) {
      "app.beanbudget.dev" -> "bean-budget-dev"
      "app.beanbudget.probe" -> "bean-budget-probe"
      else -> "bean-budget"
    }
    val intent = requireNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName))
      .setAction(Intent.ACTION_VIEW)
      .setData(Uri.parse("$scheme://$destination"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}

open class BeanWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = update(context)

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) = update(context)

  override fun onEnabled(context: Context) = update(context)

  private fun update(context: Context) {
    val pending = goAsync()
    widgetUpdates.execute {
      try {
        runCatching { BeanWidgets.refresh(context.applicationContext) }.onFailure {
          Log.w("BeanWidgets", "Could not update home screen widgets")
        }
      } finally {
        pending?.finish()
      }
    }
  }
}

class RegisterWidgetProvider : BeanWidgetProvider()

class AddWidgetProvider : BeanWidgetProvider()
