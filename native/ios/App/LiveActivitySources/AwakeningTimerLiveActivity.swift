import ActivityKit
import WidgetKit
import SwiftUI

// La scheda del recupero scelta nelle anteprime (proposta 4, "Seduta
// completa"): sessione ed esercizio, tempo della seduta, conto alla
// rovescia, prossima serie con carico e ripetizioni, serie fatte, barra.
// Allo scadere resta la stessa scheda: l'etichetta diventa "TOCCA A TE" e
// compare "Serie fatta". Nell'isola dinamica aperta si vede la stessa
// identica scheda; chiusa mostra solo anello e secondi (lo spazio che iOS
// concede alle app).

private let awGreen  = Color(red: 52 / 255, green: 211 / 255, blue: 153 / 255)
private let awIndigo = Color(red: 129 / 255, green: 140 / 255, blue: 248 / 255)
private let awMint   = Color(red: 167 / 255, green: 243 / 255, blue: 208 / 255)
private let awMuted  = Color(red: 154 / 255, green: 166 / 255, blue: 187 / 255)
private let awCardBg = Color(red: 18 / 255, green: 22 / 255, blue: 34 / 255)

private struct AppBadge: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(LinearGradient(colors: [Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255),
                                          Color(red: 79 / 255, green: 70 / 255, blue: 229 / 255)],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: 20, height: 20)
            .overlay(Text("A").font(.system(size: 10, weight: .black)).foregroundColor(.white))
    }
}

private struct SetDots: View {
    let done: Int
    let total: Int
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<max(total, 1), id: \.self) { i in
                if i < done {
                    Capsule().fill(awGreen).frame(width: 18, height: 6)
                } else if i == done {
                    Capsule().stroke(awIndigo, lineWidth: 1.5).frame(width: 18, height: 6)
                } else {
                    Capsule().fill(Color.white.opacity(0.15)).frame(width: 18, height: 6)
                }
            }
        }
    }
}

@available(iOS 16.2, *)
struct RestCardView: View {
    let attributes: RestActivityAttributes
    let state: RestActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                AppBadge()
                Text("\(attributes.sessionName) · ESERCIZIO \(state.exerciseIndex) DI \(state.exerciseCount)")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(awMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 4)
                HStack(spacing: 3) {
                    Text("in corso da")
                    Text(attributes.sessionStart, style: .timer)
                        .monospacedDigit()
                        .frame(maxWidth: 44, alignment: .leading)
                }
                .font(.system(size: 12))
                .foregroundColor(awMuted)
                .lineLimit(1)
            }

            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(isStale ? "TOCCA A TE" : "RECUPERO")
                        .font(.system(size: 12, weight: .heavy))
                        .kerning(1)
                        .foregroundColor(isStale ? awMint : awIndigo)
                    Text(timerInterval: state.restStart...state.restEnd, countsDown: true)
                        .font(.system(size: 40, weight: .heavy))
                        .monospacedDigit()
                        .foregroundColor(.white)
                        .frame(maxWidth: 130, alignment: .leading)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(state.exerciseName)
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Text("Prossima: \(state.nextLabel)")
                        .font(.system(size: 13))
                        .foregroundColor(Color(white: 0.8))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    SetDots(done: state.setsDone, total: state.setsTotal)
                        .padding(.top, 5)
                }
            }

            ProgressView(timerInterval: state.restStart...state.restEnd, countsDown: true) {
                EmptyView()
            } currentValueLabel: {
                EmptyView()
            }
            .tint(awGreen)

            if isStale {
                Link(destination: URL(string: "awakening://serie-fatta")!) {
                    Text("Serie fatta · via al recupero")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(Color.white.opacity(0.18))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }
}

@available(iOS 16.2, *)
struct AwakeningTimerLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RestActivityAttributes.self) { context in
            RestCardView(attributes: context.attributes, state: context.state, isStale: context.isStale)
                .padding(16)
                .activityBackgroundTint(awCardBg.opacity(0.85))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "awakening://seduta"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    RestCardView(attributes: context.attributes, state: context.state, isStale: context.isStale)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                ProgressView(timerInterval: context.state.restStart...context.state.restEnd, countsDown: true) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .progressViewStyle(.circular)
                .tint(awGreen)
                .frame(width: 20, height: 20)
            } compactTrailing: {
                Text(timerInterval: context.state.restStart...context.state.restEnd, countsDown: true)
                    .monospacedDigit()
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(awGreen)
                    .frame(width: 44)
            } minimal: {
                ProgressView(timerInterval: context.state.restStart...context.state.restEnd, countsDown: true) {
                    EmptyView()
                } currentValueLabel: {
                    EmptyView()
                }
                .progressViewStyle(.circular)
                .tint(awGreen)
            }
            .widgetURL(URL(string: "awakening://seduta"))
        }
    }
}
