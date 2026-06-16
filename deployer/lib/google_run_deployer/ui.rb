# frozen_string_literal: true

require "pastel"
require "tty-prompt"
require "tty-spinner"
require "tty-progressbar"
require "tty-box"

module GoogleRunDeployer
  # Presentation layer. Every TTY collaborator is injectable so specs drive a
  # TTY::Prompt::Test and stub spinner/progress factories — no real terminal,
  # no sleeps, deterministic strings (Pastel disabled).
  class UI
    def initialize(output: $stdout,
                   prompt: TTY::Prompt.new,
                   pastel: Pastel.new,
                   spinner_multi: nil,
                   spinner: nil,
                   progress: nil,
                   box: TTY::Box)
      @output = output
      @prompt = prompt
      @pastel = pastel
      @box = box
      @spinner_multi = spinner_multi || ->(title) { TTY::Spinner::Multi.new("[:spinner] #{title}", output: @output) }
      @spinner = spinner || ->(label) { TTY::Spinner.new("[:spinner] #{label}", output: @output, success_mark: "✓", error_mark: "✗") }
      @progress = progress || ->(label, total) { TTY::ProgressBar.new("#{label} [:bar] :percent", total: total, output: @output) }
    end

    def say(message)
      @output.puts(message)
    end

    def step(message)
      @output.puts(@pastel.cyan.bold("==> #{message}"))
    end

    def success(message)
      @output.puts(@pastel.green("✓ #{message}"))
    end

    def warn(message)
      @output.puts(@pastel.yellow("! #{message}"))
    end

    def error(message)
      @output.puts(@pastel.red.bold("✗ #{message}"))
    end

    def banner(title)
      @output.puts(@box.frame(title, padding: [0, 2], border: :thick))
    end

    def ask(question, default: nil)
      @prompt.ask(question, default: default)
    end

    def mask(question)
      @prompt.mask(question)
    end

    def yes?(question)
      @prompt.yes?(question)
    end

    # Run a single block under a spinner, marking success/error around it.
    def spin(label)
      spinner = @spinner.call(label)
      spinner.auto_spin
      result = yield
      spinner.success(@pastel.green("done"))
      result
    rescue StandardError => e
      spinner.error(@pastel.red("failed"))
      raise e
    end

    # Run `jobs` (label => callable) concurrently, each tracked by its own
    # child spinner in a TTY::Spinner::Multi. Returns { label => return_value }.
    # If any job raises, the rest still finish and the first error re-raises.
    def parallel(title, jobs)
      multi = @spinner_multi.call(title)
      results = {}
      errors = {}
      mutex = Mutex.new

      jobs.each do |label, callable|
        multi.register("[:spinner] #{label}") do |spinner|
          value = callable.call
          mutex.synchronize { results[label] = value }
          spinner.success(@pastel.green("done"))
        rescue StandardError => e
          mutex.synchronize { errors[label] = e }
          spinner.error(@pastel.red("failed"))
        end
      end

      multi.auto_spin
      raise errors.values.first unless errors.empty?

      results
    end

    # Advance a known-length progress bar across `items`, yielding each.
    def progress(label, items)
      bar = @progress.call(label, items.size)
      items.map do |item|
        result = yield(item)
        bar.advance
        result
      end
    end
  end
end
