package app.beanbudget.widgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.DayOfWeek
import java.util.Locale
import kotlin.math.roundToInt

private val tokyo = ZoneId.of("Asia/Tokyo")
private val dateLabel = DateTimeFormatter.ofPattern("MMM d", Locale.US)
private const val midnightAction = "app.beanbudget.widgets.TOKYO_MIDNIGHT"
internal const val widgetPreferences = "spendingWidgets"
internal val spendingLayouts = mapOf(
  SpendingWidgetProvider::class.java to R.layout.bean_spending_square,
  SpendingWideWidgetProvider::class.java to R.layout.bean_spending_wide
)

internal data class BudgetSpending(
  val id: String, val name: String, val currency: String, val todaySpent: Long,
  val weekSpent: Long, val server: String?, val dayLimit: Long?, val weekLimit: Long?
)

internal fun spendingToday(context: Context, today: LocalDate): List<BudgetSpending> {
  val file = File(context.filesDir, "SQLite/bean-budget.sqlite")
  if (!file.isFile) return emptyList()
  return SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
    require(db.version == 7)
    val monday = today.with(DayOfWeek.MONDAY)
    db.rawQuery("""
      WITH scope AS (SELECT value FROM metadata WHERE name='widgetSpendingScope'),
      budgets AS (SELECT entry.value AS budget FROM scope, json_each(scope.value, '$.budgets') entry),
      spending AS (
        SELECT json_extract(payload,'$.accountId') AS account,
               json_extract(payload,'$.date') AS day, -json_extract(payload,'$.amount') AS spent
        FROM records
        WHERE kind='transactions' AND json_extract(payload,'$.kind')='transaction'
          AND json_extract(payload,'$.transferId') IS NULL
          AND json_extract(payload,'$.date') BETWEEN ? AND ?
          AND (json_extract(payload,'$.amount') < 0 OR (
            json_extract(payload,'$.categoryId') IS NOT NULL AND id NOT IN
              (SELECT income.value FROM scope, json_each(scope.value, '$.incomeIds') income)
          ))
      )
      SELECT json_extract(budget,'$.id'), json_extract(budget,'$.name'), json_extract(budget,'$.currency'),
             SUM(CASE WHEN day=? THEN spent ELSE 0 END), COALESCE(SUM(spent),0),
             (SELECT value FROM metadata WHERE name='serverUrl'),
             json_extract(budget,'$.daily.' || ?), json_extract(budget,'$.weekly.' || ?)
      FROM budgets LEFT JOIN spending ON account IN (SELECT value FROM json_each(budget,'$.accountIds'))
      GROUP BY budget ORDER BY json_extract(budget,'$.name') COLLATE NOCASE, json_extract(budget,'$.id')
    """.trimIndent(), arrayOf(monday.toString(), today.toString(), today.toString(), today.toString(), monday.toString())).use { cursor ->
      buildList {
        while (cursor.moveToNext()) add(BudgetSpending(cursor.getString(0), cursor.getString(1),
          cursor.getString(2), cursor.getLong(3), cursor.getLong(4), cursor.getString(5),
          if (cursor.isNull(6)) null else cursor.getLong(6), if (cursor.isNull(7)) null else cursor.getLong(7)))
      }
    }
  }
}

fun updateSpendingWidgets(context: Context, manager: AppWidgetManager) {
  val instances = spendingLayouts.flatMap { (provider, layout) ->
    manager.getAppWidgetIds(ComponentName(context, provider)).map { it to layout }
  }
  val alarm = context.getSystemService(AlarmManager::class.java)
  val midnight = PendingIntent.getBroadcast(context, 0,
    Intent(context, SpendingWidgetProvider::class.java).setAction(midnightAction),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  if (instances.isEmpty()) {
    alarm.cancel(midnight)
    return
  }
  val today = LocalDate.now(tokyo)
  alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,
    today.plusDays(1).atStartOfDay(tokyo).toInstant().toEpochMilli(), midnight)
  val choices = runCatching { spendingToday(context, today) }.getOrNull()
  val prefs = context.getSharedPreferences(widgetPreferences, Context.MODE_PRIVATE)
  for ((id, layout) in instances) {
    val budget = prefs.getString("budget/$id", null)
    val server = prefs.getString("server/$id", null)
    val row = if (budget == null) choices?.singleOrNull()
      else choices?.find { it.id == budget && (server == null || it.server == server) }
    val views = RemoteViews(context.packageName, layout)
    views.setViewVisibility(R.id.bean_spending_totals, if (row == null) View.GONE else View.VISIBLE)
    views.setViewVisibility(R.id.bean_spending_heading, if (row == null) View.VISIBLE else View.GONE)
    if (row == null) {
      views.setTextViewText(R.id.bean_spending_heading, if (budget == null) "Choose a budget" else "Spending unavailable")
      views.setTextViewText(R.id.bean_spending_status, if (choices.isNullOrEmpty()) "Open Bean Budget to refresh" else "Tap to choose a budget")
      val choose = Intent(context, SpendingWidgetConfiguration::class.java)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
      views.setOnClickPendingIntent(R.id.bean_spending_root, PendingIntent.getActivity(context, id, choose,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    } else {
      if (budget == null || (server == null && row.server != null))
        prefs.edit().putString("budget/$id", row.id).putString("server/$id", row.server).apply()
      views.setOnClickPendingIntent(R.id.bean_spending_root, BeanWidgets.openApp(context, "budget/${Uri.encode(row.id)}"))
      renderSpending(context, views, row.currency, row.todaySpent, row.dayLimit, null,
        R.id.bean_spending_today_amount, R.id.bean_spending_today_bar)
      renderSpending(context, views, row.currency, row.weekSpent, row.weekLimit, today.dayOfWeek.value / 7.0,
        R.id.bean_spending_week_amount, R.id.bean_spending_week_bar)
      views.setTextViewText(R.id.bean_spending_status, "Spent · ${dateLabel.format(today)} · ${row.name}")
    }
    manager.updateAppWidget(id, views)
  }
}

private fun renderSpending(
  context: Context, views: RemoteViews, currency: String, spent: Long, limit: Long?, pace: Double?,
  amountId: Int, barId: Int
) {
  val amount = BeanWidgets.money(spent, currency)
  views.setTextViewText(amountId, amount)
  val over = limit != null && spent > limit
  views.setTextColor(amountId, context.getColor(context.resources.getIdentifier(
    if (over) "bean_widget_error" else "bean_widget_text", "color", context.packageName)))
  val fraction = when {
    limit == null -> 0.0
    limit > 0 -> spent.toDouble() / limit
    over -> 1.0
    else -> 0.0
  }
  val filled = (fraction.coerceIn(0.0, 1.0) * 10).roundToInt()
  val elapsed = if (limit != null && limit > 0 && pace != null) (pace * 10).roundToInt() else 0
  val fill = if (over || (pace != null && fraction > pace)) R.drawable.bean_spending_segment_error
    else R.drawable.bean_spending_segment_primary
  views.removeAllViews(barId)
  for (index in 0 until 10) {
    if (index > 0) views.addView(barId, RemoteViews(context.packageName, R.layout.bean_spending_gap))
    val segment = RemoteViews(context.packageName, R.layout.bean_spending_segment)
    segment.setInt(R.id.bean_spending_segment, "setBackgroundResource", when {
      index < filled -> fill
      index < elapsed -> R.drawable.bean_spending_segment_selected
      else -> R.drawable.bean_spending_segment_outline
    })
    views.addView(barId, segment)
  }
  views.setContentDescription(barId, if (limit == null) "No planned allowance"
    else "$amount spent against a ${BeanWidgets.money(limit, currency)} allowance")
}

open class SpendingWidgetProvider : BeanWidgetProvider() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      midnightAction, Intent.ACTION_DATE_CHANGED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED -> update(context)
      else -> super.onReceive(context, intent)
    }
  }

  override fun onDeleted(context: Context, ids: IntArray) {
    val prefs = context.getSharedPreferences(widgetPreferences, Context.MODE_PRIVATE).edit()
    for (id in ids) prefs.remove("budget/$id").remove("category/$id").remove("server/$id")
    prefs.apply()
  }

  override fun onDisabled(context: Context) = update(context)
}

class SpendingWideWidgetProvider : SpendingWidgetProvider()
