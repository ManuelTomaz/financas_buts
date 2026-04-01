from __future__ import annotations

import datetime as dt
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


DB_PATH = Path(__file__).with_name("financas.sqlite")


def _parse_date(value: str) -> dt.date:
    value = value.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    raise ValueError("Data inválida. Use YYYY-MM-DD ou DD/MM/YYYY.")


def _parse_year_month(value: str) -> tuple[int, int]:
    value = value.strip()
    if "/" in value:
        parts = value.split("/", 1)
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            month = int(parts[0])
            year = int(parts[1])
            if 1 <= month <= 12:
                return year, month
    if "-" in value:
        parts = value.split("-", 1)
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            year = int(parts[0])
            month = int(parts[1])
            if 1 <= month <= 12:
                return year, month
    raise ValueError("Mês inválido. Use MM/AAAA ou AAAA-MM.")


def _parse_amount_to_cents(value: str) -> int:
    raw = value.strip().replace("R$", "").strip()
    raw = raw.replace(".", "").replace(",", ".")
    try:
        amount = float(raw)
    except ValueError as e:
        raise ValueError("Valor inválido. Exemplo: 123,45") from e
    cents = int(round(amount * 100))
    return cents


def _format_cents(value: int) -> str:
    sign = "-" if value < 0 else ""
    v = abs(value)
    reais = v // 100
    cents = v % 100
    s = f"{reais:,}".replace(",", ".")
    return f"{sign}R$ {s},{cents:02d}"


def _month_range(year: int, month: int) -> tuple[dt.date, dt.date]:
    start = dt.date(year, month, 1)
    if month == 12:
        end = dt.date(year + 1, 1, 1)
    else:
        end = dt.date(year, month + 1, 1)
    return start, end


def _prompt(text: str, default: Optional[str] = None) -> str:
    if default is None:
        return input(f"{text}: ").strip()
    value = input(f"{text} [{default}]: ").strip()
    return value if value else default


def _prompt_date(text: str, default: Optional[dt.date] = None) -> dt.date:
    if default is None:
        return _parse_date(_prompt(text))
    raw = _prompt(text, default.isoformat())
    return _parse_date(raw)


def _prompt_amount(text: str) -> int:
    return _parse_amount_to_cents(_prompt(text))


def _prompt_int(text: str, default: Optional[int] = None, min_value: Optional[int] = None, max_value: Optional[int] = None) -> int:
    raw = _prompt(text, str(default) if default is not None else None)
    if not raw.strip().isdigit():
        raise ValueError("Número inválido.")
    v = int(raw)
    if min_value is not None and v < min_value:
        raise ValueError(f"O valor mínimo é {min_value}.")
    if max_value is not None and v > max_value:
        raise ValueError(f"O valor máximo é {max_value}.")
    return v


@dataclass(frozen=True)
class MonthTotals:
    income_cents: int
    expense_cents: int
    credit_cents: int
    bills_open_cents: int
    bills_paid_cents: int

    @property
    def net_cents(self) -> int:
        return self.income_cents - (self.expense_cents + self.credit_cents + self.bills_paid_cents)


def connect_db(path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL CHECK (kind IN ('income','expense','credit')),
            date TEXT NOT NULL,
            description TEXT NOT NULL,
            category TEXT,
            amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
        );

        CREATE TABLE IF NOT EXISTS bills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            due_date TEXT NOT NULL,
            description TEXT NOT NULL,
            category TEXT,
            amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
            status TEXT NOT NULL CHECK (status IN ('open','paid')) DEFAULT 'open',
            paid_date TEXT
        );

        CREATE TABLE IF NOT EXISTS recurring_bills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL,
            category TEXT,
            amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
            day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
            start_ym TEXT NOT NULL,
            end_ym TEXT
        );

        CREATE TABLE IF NOT EXISTS balances (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            bank TEXT NOT NULL,
            balance_cents INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_bills_due_date ON bills(due_date);
        CREATE INDEX IF NOT EXISTS idx_balances_date ON balances(date);
        """
    )
    conn.commit()


def add_transaction(conn: sqlite3.Connection, kind: str, date: dt.date, description: str, amount_cents: int, category: Optional[str]) -> int:
    cur = conn.execute(
        "INSERT INTO transactions(kind, date, description, category, amount_cents) VALUES(?,?,?,?,?)",
        (kind, date.isoformat(), description.strip(), (category or "").strip() or None, amount_cents),
    )
    conn.commit()
    return int(cur.lastrowid)


def add_bill(conn: sqlite3.Connection, due_date: dt.date, description: str, amount_cents: int, category: Optional[str]) -> int:
    cur = conn.execute(
        "INSERT INTO bills(due_date, description, category, amount_cents, status) VALUES(?,?,?,?, 'open')",
        (due_date.isoformat(), description.strip(), (category or "").strip() or None, amount_cents),
    )
    conn.commit()
    return int(cur.lastrowid)


def pay_bill(conn: sqlite3.Connection, bill_id: int, paid_date: dt.date) -> None:
    cur = conn.execute(
        "UPDATE bills SET status='paid', paid_date=? WHERE id=? AND status='open'",
        (paid_date.isoformat(), bill_id),
    )
    if cur.rowcount == 0:
        raise ValueError("Conta não encontrada ou já está paga.")
    conn.commit()


def list_bills(conn: sqlite3.Connection, year: int, month: int) -> list[sqlite3.Row]:
    start, end = _month_range(year, month)
    rows = conn.execute(
        """
        SELECT id, due_date, description, category, amount_cents, status, paid_date
        FROM bills
        WHERE due_date >= ? AND due_date < ?
        ORDER BY due_date ASC, id ASC
        """,
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    return list(rows)


def add_recurring_bill(conn: sqlite3.Connection, description: str, amount_cents: int, day_of_month: int, start_ym: str, end_ym: Optional[str], category: Optional[str]) -> int:
    cur = conn.execute(
        "INSERT INTO recurring_bills(description, category, amount_cents, day_of_month, start_ym, end_ym) VALUES(?,?,?,?,?,?)",
        (description.strip(), (category or "").strip() or None, amount_cents, day_of_month, start_ym, end_ym),
    )
    conn.commit()
    return int(cur.lastrowid)


def _ym_to_int(ym: str) -> int:
    year, month = _parse_year_month(ym)
    return year * 100 + month


def generate_bills_for_month(conn: sqlite3.Connection, year: int, month: int) -> int:
    ym = f"{year:04d}-{month:02d}"
    ym_int = _ym_to_int(ym)

    recurring = conn.execute(
        "SELECT id, description, category, amount_cents, day_of_month, start_ym, end_ym FROM recurring_bills"
    ).fetchall()

    created = 0
    for r in recurring:
        start_int = _ym_to_int(r["start_ym"])
        end_int = _ym_to_int(r["end_ym"]) if r["end_ym"] else None
        if ym_int < start_int:
            continue
        if end_int is not None and ym_int > end_int:
            continue
        due_date = dt.date(year, month, int(r["day_of_month"]))

        exists = conn.execute(
            """
            SELECT 1 FROM bills
            WHERE due_date = ? AND description = ? AND amount_cents = ?
            LIMIT 1
            """,
            (due_date.isoformat(), r["description"], r["amount_cents"]),
        ).fetchone()
        if exists:
            continue

        add_bill(conn, due_date, r["description"], int(r["amount_cents"]), r["category"])
        created += 1

    return created


def add_balance(conn: sqlite3.Connection, date: dt.date, bank: str, balance_cents: int) -> int:
    cur = conn.execute(
        "INSERT INTO balances(date, bank, balance_cents) VALUES(?,?,?)",
        (date.isoformat(), bank.strip(), balance_cents),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_last_balance_before(conn: sqlite3.Connection, date_exclusive: dt.date) -> Optional[sqlite3.Row]:
    row = conn.execute(
        """
        SELECT date, bank, balance_cents
        FROM balances
        WHERE date < ?
        ORDER BY date DESC, id DESC
        LIMIT 1
        """,
        (date_exclusive.isoformat(),),
    ).fetchone()
    return row


def get_last_balance_in_month(conn: sqlite3.Connection, year: int, month: int) -> Optional[sqlite3.Row]:
    start, end = _month_range(year, month)
    row = conn.execute(
        """
        SELECT date, bank, balance_cents
        FROM balances
        WHERE date >= ? AND date < ?
        ORDER BY date DESC, id DESC
        LIMIT 1
        """,
        (start.isoformat(), end.isoformat()),
    ).fetchone()
    return row


def month_totals(conn: sqlite3.Connection, year: int, month: int) -> MonthTotals:
    start, end = _month_range(year, month)
    tx = conn.execute(
        """
        SELECT kind, COALESCE(SUM(amount_cents), 0) AS total
        FROM transactions
        WHERE date >= ? AND date < ?
        GROUP BY kind
        """,
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    totals = {r["kind"]: int(r["total"]) for r in tx}

    bills = conn.execute(
        """
        SELECT status, COALESCE(SUM(amount_cents), 0) AS total
        FROM bills
        WHERE due_date >= ? AND due_date < ?
        GROUP BY status
        """,
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    bill_totals = {r["status"]: int(r["total"]) for r in bills}

    return MonthTotals(
        income_cents=totals.get("income", 0),
        expense_cents=totals.get("expense", 0),
        credit_cents=totals.get("credit", 0),
        bills_open_cents=bill_totals.get("open", 0),
        bills_paid_cents=bill_totals.get("paid", 0),
    )


def month_report(conn: sqlite3.Connection, year: int, month: int) -> str:
    start, end = _month_range(year, month)
    totals = month_totals(conn, year, month)

    last_before = get_last_balance_before(conn, start)
    last_in_month = get_last_balance_in_month(conn, year, month)

    lines: list[str] = []
    lines.append(f"Resumo {month:02d}/{year:04d}")
    lines.append("")
    if last_before:
        lines.append(f"Saldo anterior ({last_before['date']}, {last_before['bank']}): {_format_cents(int(last_before['balance_cents']))}")
    else:
        lines.append("Saldo anterior: (não informado)")
    if last_in_month:
        lines.append(f"Saldo no mês ({last_in_month['date']}, {last_in_month['bank']}): {_format_cents(int(last_in_month['balance_cents']))}")
    else:
        lines.append("Saldo no mês: (não informado)")
    lines.append("")
    lines.append(f"Entradas: {_format_cents(totals.income_cents)}")
    lines.append(f"Despesas (gastos): {_format_cents(totals.expense_cents)}")
    lines.append(f"Faturas cartão: {_format_cents(totals.credit_cents)}")
    lines.append(f"Contas pagas: {_format_cents(totals.bills_paid_cents)}")
    lines.append(f"Contas em aberto (vencem no mês): {_format_cents(totals.bills_open_cents)}")
    lines.append("")
    lines.append(f"Resultado do mês (aprox.): {_format_cents(totals.net_cents)}")
    lines.append("")

    tx_rows = conn.execute(
        """
        SELECT kind, date, description, category, amount_cents
        FROM transactions
        WHERE date >= ? AND date < ?
        ORDER BY date ASC, id ASC
        """,
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    if tx_rows:
        lines.append("Lançamentos")
        for r in tx_rows:
            kind = {"income": "Entrada", "expense": "Despesa", "credit": "Fatura"}[r["kind"]]
            cat = f" ({r['category']})" if r["category"] else ""
            lines.append(f"- {r['date']} | {kind} | {r['description']}{cat} | {_format_cents(int(r['amount_cents']))}")
        lines.append("")

    bills_rows = list_bills(conn, year, month)
    if bills_rows:
        lines.append("Contas (vencimento no mês)")
        for r in bills_rows:
            status = "PAGA" if r["status"] == "paid" else "ABERTA"
            paid = f" | paga em {r['paid_date']}" if r["paid_date"] else ""
            cat = f" ({r['category']})" if r["category"] else ""
            lines.append(f"- #{r['id']} | vence {r['due_date']} | {status}{paid} | {r['description']}{cat} | {_format_cents(int(r['amount_cents']))}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def year_report(conn: sqlite3.Connection, year: int) -> str:
    lines: list[str] = []
    lines.append(f"Resumo anual {year:04d}")
    lines.append("")

    annual_income = 0
    annual_expense = 0
    annual_credit = 0
    annual_bills_paid = 0
    annual_bills_open = 0
    annual_net = 0

    for month in range(1, 13):
        totals = month_totals(conn, year, month)
        annual_income += totals.income_cents
        annual_expense += totals.expense_cents
        annual_credit += totals.credit_cents
        annual_bills_paid += totals.bills_paid_cents
        annual_bills_open += totals.bills_open_cents
        annual_net += totals.net_cents

        lines.append(
            f"{month:02d}/{year:04d} | Entradas {_format_cents(totals.income_cents)} | "
            f"Saídas {_format_cents(totals.expense_cents + totals.credit_cents + totals.bills_paid_cents)} | "
            f"Resultado {_format_cents(totals.net_cents)} | "
            f"Aberto {_format_cents(totals.bills_open_cents)}"
        )

    lines.append("")
    lines.append("Totais do ano")
    lines.append(f"- Entradas: {_format_cents(annual_income)}")
    lines.append(f"- Despesas (gastos): {_format_cents(annual_expense)}")
    lines.append(f"- Faturas cartão: {_format_cents(annual_credit)}")
    lines.append(f"- Contas pagas: {_format_cents(annual_bills_paid)}")
    lines.append(f"- Contas em aberto (vencem no mês): {_format_cents(annual_bills_open)}")
    lines.append(f"- Resultado do ano (aprox.): {_format_cents(annual_net)}")
    lines.append("")
    return "\n".join(lines)


def _print_header() -> None:
    print("")
    print("Finanças (simples) — controle mensal e anual")
    print(f"Base de dados: {DB_PATH}")
    print("")


def _menu() -> None:
    conn = connect_db()
    init_db(conn)

    while True:
        _print_header()
        today = dt.date.today()
        ym_default = f"{today.month:02d}/{today.year:04d}"
        print("1) Lançar entrada")
        print("2) Lançar despesa (gasto)")
        print("3) Lançar fatura de cartão")
        print("4) Cadastrar conta a pagar (com vencimento)")
        print("5) Marcar conta como paga")
        print("6) Registrar saldo do banco")
        print("7) Gerar contas recorrentes do mês")
        print("8) Resumo do mês")
        print("9) Resumo do ano")
        print("10) Cadastrar conta recorrente")
        print("0) Sair")
        print("")

        choice = input("Escolha: ").strip()
        try:
            if choice == "0":
                break
            if choice == "1":
                date = _prompt_date("Data", today)
                desc = _prompt("Descrição")
                cat = _prompt("Categoria (opcional)", "")
                amount = _prompt_amount("Valor (ex: 123,45)")
                add_transaction(conn, "income", date, desc, amount, cat)
                print("Entrada registrada.")
                input("Enter para continuar...")
            elif choice == "2":
                date = _prompt_date("Data", today)
                desc = _prompt("Descrição")
                cat = _prompt("Categoria (opcional)", "")
                amount = _prompt_amount("Valor (ex: 123,45)")
                add_transaction(conn, "expense", date, desc, amount, cat)
                print("Despesa registrada.")
                input("Enter para continuar...")
            elif choice == "3":
                date = _prompt_date("Data", today)
                desc = _prompt("Cartão/Descrição da fatura")
                cat = _prompt("Categoria (opcional)", "Cartão")
                amount = _prompt_amount("Valor (ex: 123,45)")
                add_transaction(conn, "credit", date, desc, amount, cat)
                print("Fatura registrada.")
                input("Enter para continuar...")
            elif choice == "4":
                due = _prompt_date("Vencimento", today)
                desc = _prompt("Descrição")
                cat = _prompt("Categoria (opcional)", "")
                amount = _prompt_amount("Valor (ex: 123,45)")
                bill_id = add_bill(conn, due, desc, amount, cat)
                print(f"Conta cadastrada (# {bill_id}).")
                input("Enter para continuar...")
            elif choice == "5":
                raw_ym = _prompt("Mês para listar contas (MM/AAAA)", ym_default)
                year, month = _parse_year_month(raw_ym)
                bills = list_bills(conn, year, month)
                if not bills:
                    print("Nenhuma conta nesse mês.")
                    input("Enter para continuar...")
                    continue
                print("")
                for r in bills:
                    status = "PAGA" if r["status"] == "paid" else "ABERTA"
                    print(f"#{r['id']} | vence {r['due_date']} | {status} | {r['description']} | {_format_cents(int(r['amount_cents']))}")
                print("")
                bill_id = _prompt_int("Digite o ID para marcar como paga", min_value=1)
                paid_date = _prompt_date("Data do pagamento", today)
                pay_bill(conn, bill_id, paid_date)
                print("Conta marcada como paga.")
                input("Enter para continuar...")
            elif choice == "6":
                date = _prompt_date("Data", today)
                bank = _prompt("Banco/Conta", "Banco")
                balance = _prompt_amount("Saldo (ex: 123,45)")
                add_balance(conn, date, bank, balance)
                print("Saldo registrado.")
                input("Enter para continuar...")
            elif choice == "7":
                raw_ym = _prompt("Mês (MM/AAAA)", ym_default)
                year, month = _parse_year_month(raw_ym)
                created = generate_bills_for_month(conn, year, month)
                print(f"Contas criadas: {created}")
                input("Enter para continuar...")
            elif choice == "8":
                raw_ym = _prompt("Mês (MM/AAAA)", ym_default)
                year, month = _parse_year_month(raw_ym)
                print("")
                print(month_report(conn, year, month))
                input("Enter para continuar...")
            elif choice == "9":
                y = _prompt_int("Ano", default=today.year, min_value=1900, max_value=3000)
                print("")
                print(year_report(conn, y))
                input("Enter para continuar...")
            elif choice == "10":
                desc = _prompt("Descrição")
                cat = _prompt("Categoria (opcional)", "")
                amount = _prompt_amount("Valor (ex: 123,45)")
                day = _prompt_int("Dia do mês (1 a 28)", min_value=1, max_value=28)
                start_ym = _prompt("Início (MM/AAAA)", ym_default)
                end_ym = _prompt("Fim (opcional, MM/AAAA)", "")
                end_ym = end_ym.strip() or None
                start_norm = f"{_parse_year_month(start_ym)[0]:04d}-{_parse_year_month(start_ym)[1]:02d}"
                end_norm = f"{_parse_year_month(end_ym)[0]:04d}-{_parse_year_month(end_ym)[1]:02d}" if end_ym else None
                rid = add_recurring_bill(conn, desc, amount, day, start_norm, end_norm, cat)
                print(f"Conta recorrente cadastrada (# {rid}).")
                input("Enter para continuar...")
            else:
                print("Opção inválida.")
                input("Enter para continuar...")
        except Exception as e:
            print(f"Erro: {e}")
            input("Enter para continuar...")


def main(argv: Optional[Iterable[str]] = None) -> int:
    _menu()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

