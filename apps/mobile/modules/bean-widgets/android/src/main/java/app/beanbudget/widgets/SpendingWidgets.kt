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
import org.json.JSONArray
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
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

internal data class CategorySpending(
  val budget: String, val category: String, val budgetName: String, val name: String,
  val currency: String, val weekLimit: Long, val weekSpent: Long, val pace: Double,
  val todayLimit: Long?, val todaySpent: Long?, val server: String?, val calculated: LocalDate
)

internal fun spendingToday(context: Context, today: LocalDate): List<CategorySpending> {
  val file = File(context.filesDir, "SQLite/bean-budget.sqlite")
  if (!file.isFile) return emptyList()
  return SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
    require(db.version == 6)
    db.rawQuery("""
      SELECT budgetId,categoryId,budgetName,categoryName,currency,weekLimit,spent,start,end,daily,
        (SELECT value FROM metadata WHERE name='serverUrl'), (SELECT value FROM metadata WHERE name='widgetCalendarDate')
      FROM spending_widget_weeks
      WHERE start <= ? AND end > ? AND (SELECT value FROM metadata WHERE name='widgetCalendarDate') <= ?
      ORDER BY budgetName COLLATE NOCASE, categoryName COLLATE NOCASE, budgetId, categoryId
    """.trimIndent(), Array(3) { today.toString() }).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          val start = LocalDate.parse(cursor.getString(7))
          val length = ChronoUnit.DAYS.between(start, LocalDate.parse(cursor.getString(8)))
          val index = ChronoUnit.DAYS.between(start, today)
          require(length in 1L..7L && index in 0 until length)
          val daily = cursor.getString(9)?.let { JSONArray(it).getJSONObject(index.toInt()) }
          val currency = cursor.getString(4)
          require(currency == "JPY" || currency == "USD")
          add(CategorySpending(cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getString(3),
            currency, cursor.getLong(5), cursor.getLong(6), (index + 1).toDouble() / length,
            daily?.getLong("limit"), daily?.getLong("spent"), cursor.getString(10), LocalDate.parse(cursor.getString(11))))
        }
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
    val category = prefs.getString("category/$id", null)
    val server = prefs.getString("server/$id", null)
    val row = choices?.find { it.budget == budget && it.category == category && (server == null || server == it.server) }
    val views = RemoteViews(context.packageName, layout)
    views.setViewVisibility(R.id.bean_spending_today_row, if (row?.todayLimit != null) View.VISIBLE else View.GONE)
    views.setViewVisibility(R.id.bean_spending_week_row, if (row != null) View.VISIBLE else View.GONE)
    if (row == null) {
      views.setContentDescription(R.id.bean_spending_category, null)
      views.setTextViewText(R.id.bean_spending_category, if (budget == null) "Choose a category" else "Spending unavailable")
      views.setTextViewText(R.id.bean_spending_status, when {
        choices == null || choices.isEmpty() -> "Open Bean Budget to refresh your plans"
        budget == null -> "Tap to select a budget and category"
        else -> "Tap to choose an active category"
      })
      val choose = Intent(context, SpendingWidgetConfiguration::class.java)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
      views.setOnClickPendingIntent(R.id.bean_spending_root, PendingIntent.getActivity(context, id, choose,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    } else {
      if (server == null && row.server != null) prefs.edit().putString("server/$id", row.server).apply()
      val destination = "budget/${Uri.encode(row.budget)}/${Uri.encode(row.category)}"
      views.setOnClickPendingIntent(R.id.bean_spending_root, BeanWidgets.openApp(context, destination))
      views.setTextViewText(R.id.bean_spending_category, row.name)
      val asOf = dateLabel.format(today)
      val source = if (row.calculated == today) row.budgetName else "Local ${dateLabel.format(row.calculated)}"
      views.setTextViewText(R.id.bean_spending_status, "$asOf · $source")
      views.setContentDescription(R.id.bean_spending_category, "${row.name}, ${row.budgetName}")
      setSpending(context, views, row.weekLimit, row.weekSpent, row.currency, row.pace,
        R.id.bean_spending_week_amount, R.id.bean_spending_week_bar)
      if (row.todayLimit != null && row.todaySpent != null) {
        setSpending(context, views, row.todayLimit, row.todaySpent, row.currency, null,
          R.id.bean_spending_today_amount, R.id.bean_spending_today_bar)
      }
    }
    manager.updateAppWidget(id, views)
  }
}

private fun setSpending(context: Context, views: RemoteViews, limit: Long, spent: Long, currency: String,
  pace: Double?, amountId: Int, barId: Int) {
  val over = spent > limit
  views.setTextViewText(amountId, BeanWidgets.money(limit - spent, currency))
  views.setTextColor(amountId, context.getColor(context.resources.getIdentifier(
    "bean_widget_${if (over) "error" else "text"}", "color", context.packageName)))
  val ratio = if (limit > 0) spent.toDouble() / limit else if (over) 1.0 else 0.0
  val lit = (ratio.coerceIn(0.0, 1.0) * 10).roundToInt()
  val paceSegments = ((pace ?: 0.0) * 10).roundToInt()
  val fill = if (over || (pace != null && ratio > pace)) R.drawable.bean_spending_segment_error
    else R.drawable.bean_spending_segment_primary
  views.removeAllViews(barId)
  for (index in 0 until 10) {
    if (index > 0) views.addView(barId, RemoteViews(context.packageName, R.layout.bean_spending_gap))
    val segment = RemoteViews(context.packageName, R.layout.bean_spending_segment)
    segment.setInt(R.id.bean_spending_segment, "setBackgroundResource", when {
      index < lit -> fill
      index < paceSegments -> R.drawable.bean_spending_segment_selected
      else -> R.drawable.bean_spending_segment_outline
    })
    views.addView(barId, segment)
  }
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
